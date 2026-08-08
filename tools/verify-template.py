#!/usr/bin/env python3
"""
Render a chat template against every content shape Claude Code actually produces.

    python3 tools/verify-template.py templates/claude-code-fable5.jinja
    python3 tools/verify-template.py /path/to/your-template.jinja

Requires jinja2 (`pip install jinja2`). Kept out of `npm test` because the Node suite
has no dependencies; run this by hand when you change a template.

Two failure modes matter, and both are silent until a session dies:

  HARD FAIL  — the template calls raise_exception on a block it does not recognize.
               The request 400s, the block stays in the conversation history, and
               every retry raises again. The session cannot recover.

  DROPPED    — the template renders without error but silently loses content. The
               model then behaves as if it was never told something it was told.
               Mid-conversation system messages are the common casualty: Claude Code
               sent 46 of them in one captured session.
"""

import sys
import json

try:
    import jinja2
except ImportError:
    sys.exit("jinja2 is required: pip install jinja2")


def build_env():
    env = jinja2.Environment(undefined=jinja2.ChainableUndefined)

    def raise_exception(message):
        raise jinja2.exceptions.TemplateError(message)

    env.globals["raise_exception"] = raise_exception
    env.policies["json.dumps_kwargs"] = {"ensure_ascii": False}
    return env


IMAGE = {
    "type": "image",
    "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="},
}

TOOLS = [
    {
        "name": "Read",
        "description": "Read a file",
        "input_schema": {"type": "object", "properties": {"p": {"type": "string"}}},
    }
]

# name -> (messages, [strings that must survive into the rendered prompt])
CASES = {
    "empty messages (warm-up / token count)": ([], []),
    "plain string content": ([{"role": "user", "content": "PROBE-plain"}], ["PROBE-plain"]),
    "tool_result as a string": (
        [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": "PROBE-tr-string"}]}],
        ["PROBE-tr-string"],
    ),
    "tool_result as blocks": (
        [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "PROBE-tr-block"}]}]}],
        ["PROBE-tr-block"],
    ),
    "tool_reference in tool_result (the wedge)": (
        [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": [
            {"type": "tool_reference", "tool_name": "PROBEWrite"},
            {"type": "tool_reference", "tool_name": "PROBEBash"}]}]}],
        ["PROBEWrite", "PROBEBash"],
    ),
    "image inside tool_result (screenshot)": (
        [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "PROBE-shot"}, IMAGE]}]}],
        ["PROBE-shot", "image_pad"],
    ),
    "image in a system turn": (
        [{"role": "system", "content": [{"type": "text", "text": "PROBE-sysimg"}, IMAGE]}, {"role": "user", "content": "go"}],
        ["PROBE-sysimg"],
    ),
    "inline tool_use block": (
        [{"role": "assistant", "content": [{"type": "tool_use", "id": "a", "name": "PROBEtool", "input": {"p": "/tmp/x"}}]}],
        ["PROBEtool"],
    ),
    "thinking block": (
        [{"role": "assistant", "content": [{"type": "thinking", "thinking": "PROBE-think", "signature": ""}, {"type": "text", "text": "PROBE-answer"}]}],
        ["PROBE-answer"],
    ),
    "mid-conversation system messages": (
        [{"role": "user", "content": "a"},
         {"role": "system", "content": "PROBE-midsys-1"},
         {"role": "assistant", "content": "b"},
         {"role": "system", "content": "PROBE-midsys-2"},
         {"role": "user", "content": "c"}],
        ["PROBE-midsys-1", "PROBE-midsys-2"],
    ),
    "tool_calls with mapping arguments": (
        [{"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "Read", "arguments": {"p": "PROBE-mapping"}}}]}],
        ["PROBE-mapping"],
    ),
    "tool_calls with JSON-string arguments": (
        [{"role": "assistant", "content": "", "tool_calls": [{"function": {"name": "Read", "arguments": '{"p":"PROBE-strargs"}'}}]}],
        ["PROBE-strargs"],
    ),
    "role: tool": (
        [{"role": "assistant", "content": "x"}, {"role": "tool", "content": "PROBE-toolrole"}],
        ["PROBE-toolrole"],
    ),
    "unrecognized role": ([{"role": "ctx", "content": "PROBE-ctx"}], ["PROBE-ctx"]),
    "unrecognized block type": ([{"role": "user", "content": [{"type": "some_2027_block", "payload": 1}]}], []),
    "LM Studio native message block": (
        [{"role": "user", "content": [{"type": "message", "content": "PROBE-native"}]}],
        ["PROBE-native"],
    ),
    "document block": ([{"role": "user", "content": [{"type": "document", "title": "spec"}]}], []),
    "null content": ([{"role": "user", "content": None}], []),
}


def scan_raise_exception(source):
    """
    Find raise_exception calls, which are a hazard before any message is rendered.

    llama.cpp does not merely execute the template — it statically analyses it to
    generate a tool-call parser. A raise_exception reachable during that analysis
    fails the whole model with:

        Unable to generate parser for this template. Automatic parser generation
        failed: ... Error: Jinja Exception: System message must be at the beginning.

    That is a load-time failure, so no amount of render testing catches it. The only
    safe number is zero.
    """
    hits = []
    for number, line in enumerate(source.splitlines(), start=1):
        if "raise_exception" in line and not line.lstrip().startswith("{#"):
            hits.append((number, line.strip()[:110]))
    return hits


def main(argv):
    if len(argv) < 2:
        sys.exit(f"usage: {argv[0]} <template.jinja>")
    path = argv[1]

    with open(path, encoding="utf-8") as handle:
        source = handle.read()

    raises = scan_raise_exception(source)
    if raises:
        print(f"  LOAD RISK  {len(raises)} raise_exception call(s):")
        for number, text in raises:
            print(f"             line {number}: {text}")
        print()

    template = build_env().from_string(source)

    hard, dropped = [], []
    for name, (messages, probes) in CASES.items():
        try:
            out = template.render(messages=messages, tools=TOOLS, add_generation_prompt=True)
        except Exception as err:  # noqa: BLE001 - any template error is a hard failure
            hard.append(name)
            print(f"  HARD FAIL  {name}\n             {err}")
            continue

        missing = [p for p in probes if p not in out]
        if missing:
            dropped.append(name)
            print(f"  DROPPED    {name}\n             lost: {', '.join(missing)}")
        else:
            print(f"  ok         {name}")

    print()
    print(f"{path}")
    print(f"  raise_exception : {len(raises)}")
    print(f"  hard failures   : {len(hard)}")
    print(f"  silent drops    : {len(dropped)}")

    if hard:
        print("\nA hard failure is unrecoverable: the block stays in history and every retry raises again.")
    if dropped:
        print("\nA silent drop means the model never sees content Claude Code sent it.")

    if raises:
        print(
            "\nEach raise_exception is a way for this template to fail the model at load\n"
            "time, before a single message is rendered. Replace them with a fallback."
        )

    return 1 if (hard or dropped or raises) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
