"""
Witness: the boundary recorder for Python.

A pytest plugin. It wraps exactly one function, named by module and
qualified name, and records one observation per entry: the test that was
running, an index and a depth within that test, the arguments as they
arrived, and how the call ended.

It produces the same tagged records the JavaScript recorder produces, so
the comparator and the verdict never learn which language a record came
from. There is one behaviour gate and one meaning of equivalent.

Two rules this file exists to keep.

Arguments are snapshotted at entry, by copy. A function that mutates what
it was handed would otherwise be compared against its own mutation, and
every such function would report equivalent no matter what changed.

A coroutine function is wrapped by a coroutine that awaits the original,
so the observation happens inside the async boundary. Nothing is ever
attached to a caller-visible awaitable, and exception propagation and
scheduling are left exactly as they were.

Plain standard library with no dependencies beyond pytest itself: it is
copied into the calling tool's folder in the project and loaded by the project's
own interpreter with `-p`. It must never raise into the code it is
watching.
"""

import datetime
import functools
import inspect
import json
import os
import re
import threading

#: How deep a value is walked, and how many nodes of it are visited,
#: before it is given up on. The same bounds the JavaScript recorder uses.
MAX_DEPTH = 20
MAX_NODES = 10000

_dir = os.environ.get("WITNESS_BOUNDARY_DIR")
_file = os.path.join(_dir, "boundary-%d.jsonl" % os.getpid()) if _dir else None


def _read_target():
    """
    The one function this run watches, as the driver puts it in the
    environment. One JSON shape carries both languages: JavaScript reads
    `file`, Python reads `module`, and both read `name` and `container`.
    """
    raw = os.environ.get("WITNESS_BOUNDARY_TARGET")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(parsed, dict) or not parsed.get("name") or not parsed.get("module"):
        return None
    return parsed


_target = _read_target()

#: The test that is running, the entry count per test, and the current
#: nesting depth.
_current = None
_counts = {}
_depth = 0
_lock = threading.Lock()

#: Python's `re` flags, in the letter form the JavaScript recorder writes,
#: so one shape carries both languages. `re.UNICODE` is left out because
#: Python sets it on every string pattern, so it would be a constant in
#: every record and tell the comparator nothing.
_FLAG_LETTERS = ((re.IGNORECASE, "i"), (re.MULTILINE, "m"), (re.DOTALL, "s"), (re.VERBOSE, "x"), (re.ASCII, "a"))


def _uncomparable(why):
    return {"t": "uncomparable", "why": why}


def _flags(pattern):
    return "".join(letter for bit, letter in _FLAG_LETTERS if pattern.flags & bit)


def _capture(value, seen, budget, at):
    """
    A value in the tagged, language-neutral form the comparator reads.

    Anything outside the comparable set is marked with the reason rather
    than guessed at, and a value that crosses a bound is marked rather
    than truncated: comparing a truncated value would pass two different
    things as the same, which is the one answer this gate must never give.
    """
    if at > MAX_DEPTH:
        return _uncomparable("depth-limit")
    budget[0] += 1
    if budget[0] > MAX_NODES:
        return _uncomparable("node-limit")
    if value is None:
        return {"t": "null"}
    # bool before int, because in Python a bool is an int.
    if value is True or value is False:
        return {"t": "bool", "v": value}
    if isinstance(value, (int, float)):
        return {"t": "num", "v": repr(value)}
    if isinstance(value, str):
        return {"t": "str", "v": value}
    if isinstance(value, datetime.datetime):
        # An instant, in the milliseconds the JavaScript recorder writes. A
        # naive datetime has no instant, so it has nothing to compare.
        if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
            return _uncomparable("naive-datetime")
        return {"t": "date", "v": int(value.timestamp() * 1000)}
    if isinstance(value, re.Pattern):
        source = value.pattern
        if isinstance(source, bytes):
            return _uncomparable("bytes-pattern")
        return {"t": "regex", "v": {"source": source, "flags": _flags(value)}}
    if inspect.isawaitable(value) or inspect.iscoroutine(value):
        # Nothing is attached to it. Awaiting a caller-visible awaitable
        # from out here would consume it.
        return _uncomparable("awaitable")
    if callable(value):
        return _uncomparable("function")
    if isinstance(value, (set, frozenset, bytes, bytearray)):
        return _uncomparable(type(value).__name__)
    if id(value) in seen:
        return _uncomparable("cycle")
    seen.add(id(value))
    try:
        # A tuple records as an array, because JavaScript has no tuple. A
        # change from a list to a tuple is not detected. That is the stated
        # price of one comparator and one meaning of equivalent.
        if isinstance(value, (list, tuple)):
            return {"t": "array", "v": [_capture(item, seen, budget, at + 1) for item in value]}
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                return _uncomparable("non-string-keys")
            return {"t": "object", "v": {key: _capture(value[key], seen, budget, at + 1) for key in sorted(value)}}
        return _uncomparable("instance:%s" % type(value).__name__)
    finally:
        seen.discard(id(value))


def _capture_value(value):
    try:
        return _capture(value, set(), [0], 0)
    except Exception:
        return _uncomparable("capture-failed")


def _capture_arguments(signature, receiver, args, kwargs):
    """
    The arguments as one array, in parameter order, exactly as JavaScript's
    `arguments` arrives.

    Two things have to happen for that to be true. The receiver is dropped,
    because `self` is not an argument and JavaScript never records `this`.
    And the call is bound to the signature with its defaults applied, so
    `greet("Jeff", False)` and `greet("Jeff", loud=True)` record as the same
    call, which is what they are. Recording positional and keyword forms
    differently would make two runs of an unchanged test fail to pair.

    A call that will not bind cannot be described honestly, so it is marked
    rather than guessed at.
    """
    if signature is None:
        return _uncomparable("unbindable")
    try:
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        values = [bound.arguments[name] for name in signature.parameters if name in bound.arguments]
    except TypeError:
        return _uncomparable("unbindable")
    if receiver and values:
        values = values[1:]
    return _capture_value(values)


def _write(record):
    if not _file:
        return
    try:
        with open(_file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")
    except Exception:
        # Never fail the person's tests over an observation.
        pass


def _error(exception):
    return {"t": "error", "v": {"name": type(exception).__name__, "message": str(exception)}}


def _enter(target, signature, receiver, args, kwargs):
    """Start an observation. Returns a one-shot finish, or None when it could not start."""
    global _depth
    try:
        with _lock:
            key = _current if _current is not None else "\u0000no-test"
            index = _counts.get(key, 0)
            _counts[key] = index + 1
            observation = {"target": target, "test": _current, "index": index, "depth": _depth, "args": _capture_arguments(signature, receiver, args, kwargs)}
            _depth += 1
    except Exception:
        return None

    state = {"done": False}

    def finish(kind, value):
        global _depth
        if state["done"]:
            return
        state["done"] = True
        try:
            with _lock:
                _depth -= 1
            observation["outcome"] = {"kind": kind, "value": value}
            _write(observation)
        except Exception:
            pass

    return finish


def _wrap(function, target, receiver):
    """The recording wrapper, matching the original's own async-ness."""
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        signature = None

    if inspect.iscoroutinefunction(function):

        @functools.wraps(function)
        async def recorded_async(*args, **kwargs):
            finish = _enter(target, signature, receiver, args, kwargs)
            try:
                result = await function(*args, **kwargs)
            except BaseException as error:
                if finish:
                    finish("reject", _error(error))
                raise
            if finish:
                finish("resolve", _capture_value(result))
            return result

        return recorded_async

    @functools.wraps(function)
    def recorded(*args, **kwargs):
        finish = _enter(target, signature, receiver, args, kwargs)
        try:
            result = function(*args, **kwargs)
        except BaseException as error:
            if finish:
                finish("throw", _error(error))
            raise
        if finish:
            finish("return", _capture_value(result))
        return result

    return recorded


def _attach(target):
    """
    Wrap the named function. Returns None on success, or the reason it could
    not and the best name it has for what was asked for, which the gate
    reports as insufficient evidence rather than as a pass.
    """
    fallback = f"{target['container']}.{target['name']}" if target.get("container") else target["name"]
    try:
        module = __import__(target["module"], fromlist=["*"])
    except Exception:
        return ("target-not-found", fallback)

    name = target["name"]
    if target.get("container"):
        owner = module
        for part in str(target["container"]).split("."):
            owner = getattr(owner, part, None)
            if owner is None:
                return ("target-not-found", fallback)
        if not hasattr(owner, name):
            return ("target-not-found", fallback)
    else:
        # No container given, which is what the editor knows for a Python
        # method: it has the name and the file, not the class. So the module
        # is searched for exactly one holder of that name. Two holders is a
        # question for the caller, never a guess, and the gate then reports
        # that it could not find the method rather than watching the wrong one.
        holders = []
        if name in vars(module):
            holders.append(module)
        for value in list(vars(module).values()):
            if inspect.isclass(value) and getattr(value, "__module__", None) == module.__name__ and name in vars(value):
                holders.append(value)
        if len(holders) != 1:
            return ("target-not-found", fallback)
        owner = holders[0]

    label = f"{owner.__name__}.{name}" if inspect.isclass(owner) else name
    raw = owner.__dict__.get(name) if hasattr(owner, "__dict__") else None
    if isinstance(raw, (staticmethod, classmethod, property)):
        # Bounded on purpose. A descriptor needs its own rewrapping, and
        # guessing at one would be a recorder that changes what it measures.
        return ("unsupported-target", label)
    original = getattr(owner, name, None)
    if original is None or not inspect.isfunction(original):
        return ("unsupported-target", label)

    setattr(owner, name, _wrap(original, label, inspect.isclass(owner)))
    return None


# ---------------------------------------------------------------- pytest

def pytest_configure(config):
    if not _target:
        return
    problem = _attach(_target)
    if problem:
        _write({"problem": problem[0], "target": problem[1]})


def pytest_runtest_logstart(nodeid, location):
    """The test identity every observation carries is pytest's own node id."""
    global _current
    _current = nodeid


def pytest_runtest_logfinish(nodeid, location):
    global _current
    _current = None
