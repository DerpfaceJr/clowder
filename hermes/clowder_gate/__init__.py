"""Clowder's gate for Hermes (docs/product-plan.md 4.9). Shipped in Clowder and copied into Clowder's own HERMES_HOME on every start.

pre_tool_call asks Clowder before every tool call: allow runs it, ask parks it until the owner answers the Clowder card, anything else blocks it.
No answer, a slow answer or a strange answer blocks it too (fail closed, hermes-spike.md step 3). post_tool_call reports the result back.
At load it says hello with this process's PID and the nonce Clowder gave this spawn; Clowder starts no run until that hello arrives.
Standard library only.
"""
import json
import os
import time
import urllib.request

_URL = os.environ.get("CLOWDER_GATE_URL", "")
_TOKEN = os.environ.get("CLOWDER_HERMES_TOKEN", "")
_NONCE = os.environ.get("CLOWDER_HERMES_NONCE", "")
# Under Hermes's 30 s hook_callback_timeout, so Hermes's own timeout (and its 60 s skip window) never starts (spike S4).
_GATE_TIMEOUT = 10
_RESULT_CAP = 12000


def _post(path, body, timeout):
    # X-Town-Action: Clowder's local write header; the gate token is the credential.
    req = urllib.request.Request(_URL + path, data=json.dumps(body, default=str).encode(), method="POST", headers={
        "Authorization": "Bearer " + _TOKEN, "Content-Type": "application/json", "X-Town-Action": "owner"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _gate(tool_name="", args=None, task_id="", session_id="", tool_call_id="", turn_id="", **_):
    body = {"v": 1, "tool": tool_name, "args": args if isinstance(args, dict) else {}, "session_id": session_id, "task_id": task_id,
            "tool_call_id": tool_call_id, "turn_id": turn_id, "pid": os.getpid(), "nonce": _NONCE, "t": int(time.time() * 1000),
            # Read per call: the gateway sets it after plugins load on a fresh home. Without it Hermes blocks an approve instead of parking it.
            "exec_ask": os.environ.get("HERMES_EXEC_ASK", "")}
    try:
        d = _post("/api/hermes/gate", body, _GATE_TIMEOUT)
        act = d.get("action")
        if act == "allow":
            return None
        if act == "ask":
            # A rule key unique to the card, so Hermes's own caches never match a later call.
            return {"action": "approve", "message": str(d.get("message") or ""), "rule_key": "clowder:" + str(d["approval"])}
        return {"action": "block", "message": str(d.get("message") or "Blocked by Clowder.")}
    except Exception as e:
        return {"action": "block", "message": "Clowder did not answer (%s); not run." % type(e).__name__}


def _result(tool_name="", result=None, session_id="", tool_call_id="", status="", error_message="", **_):
    try:
        _post("/api/hermes/result", {"v": 1, "tool": tool_name, "session_id": session_id, "tool_call_id": tool_call_id, "status": str(status or ""),
                                     "result": str(result if result is not None else "")[:_RESULT_CAP], "error": str(error_message or "")[:2000],
                                     "nonce": _NONCE}, 3)
    except Exception:
        pass  # an observer: a lost result never holds up the Mayor


def register(ctx):
    ctx.register_hook("pre_tool_call", _gate)
    ctx.register_hook("post_tool_call", _result)
    for _attempt in range(3):
        try:
            _post("/api/hermes/hello", {"v": 1, "pid": os.getpid(), "nonce": _NONCE, "exec_ask": os.environ.get("HERMES_EXEC_ASK", "")}, 3)
            return
        except Exception:
            time.sleep(1)  # no hello: Clowder never marks this Hermes ready, so no run starts
