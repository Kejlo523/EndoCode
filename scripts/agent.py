#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.request
from pathlib import Path


SYSTEM_PROMPT = """Jestes lokalnym agentem kodujacym, dzialajacym w stylu Codex.
Masz sandbox plikowy. Wolno ci czytac, tworzyc i zmieniac pliki tylko przez narzedzia ponizej.

Zasady:
- Nie probuj wychodzic poza katalog sandboxa.
- Najpierw sprawdzaj pliki narzedziami, potem proponuj albo wykonuj male zmiany.
- Jezeli potrzebujesz komendy shell, uzyj narzedzia run_powershell. Uzytkownik zatwierdzi komende.
- Odpowiadaj wylacznie JSON-em. Nie uzywaj Markdown poza wartosciami string.

Format akcji:
{"tool":"pwd","args":{}}
{"tool":"cd","args":{"path":"podfolder"}}
{"tool":"ls","args":{"path":".","max_entries":100}}
{"tool":"read_file","args":{"path":"plik.txt","max_bytes":20000}}
{"tool":"write_file","args":{"path":"plik.txt","content":"...","mode":"overwrite"}}
{"tool":"mkdir","args":{"path":"folder"}}
{"tool":"replace_text","args":{"path":"plik.txt","old":"stary tekst","new":"nowy tekst","count":1}}
{"tool":"run_powershell","args":{"command":"pytest","timeout":60}}

Gdy konczysz odpowiedz dla uzytkownika:
{"final":"krotka odpowiedz po polsku"}
"""


BLOCKED_SHELL_PATTERNS = [
    (re.compile(r"(?i)(^|[^a-z0-9_])(invoke-webrequest|curl|wget|bitsadmin|ssh|scp|sftp)\b"), "network/download commands are blocked in the sandbox shell"),
    (re.compile(r"(?i)(^|[^a-z0-9_])(start-process|powershell|pwsh|cmd|wsl|docker)\b"), "process launcher commands are blocked"),
    (re.compile(r"(?i)[a-z]:[\\/]"), "absolute Windows paths are blocked"),
    (re.compile(r"(^|\s)\\\\|\s//"), "UNC/network paths are blocked"),
    (re.compile(r"(^|[\s\"'])~([\\/]|[\s\"']|$)"), "home-directory shortcuts are blocked"),
    (re.compile(r"(^|[\s\"'])\.\.([\\/]|[\s\"']|$)"), "parent-directory traversal is blocked"),
]


class SandboxError(Exception):
    pass


class Sandbox:
    def __init__(self, root: Path, approval_mode: str):
        self.root = root.resolve()
        self.cwd = self.root
        self.approval_mode = approval_mode
        self.tmp = self.root / ".tmp"
        self.root.mkdir(parents=True, exist_ok=True)
        self.tmp.mkdir(parents=True, exist_ok=True)

    def _resolve(self, raw_path: str | None) -> Path:
        if raw_path is None or str(raw_path).strip() == "":
            raw_path = "."
        raw = Path(str(raw_path))
        target = raw if raw.is_absolute() else self.cwd / raw
        resolved = target.resolve(strict=False)
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:
            raise SandboxError(f"path escapes sandbox: {raw_path}") from exc
        return resolved

    def _rel(self, path: Path) -> str:
        try:
            return str(path.resolve(strict=False).relative_to(self.root))
        except ValueError:
            return str(path)

    def pwd(self) -> dict:
        return {"cwd": self._rel(self.cwd), "root": str(self.root)}

    def cd(self, path: str = ".") -> dict:
        target = self._resolve(path)
        if not target.exists() or not target.is_dir():
            raise SandboxError(f"not a directory: {path}")
        self.cwd = target
        return self.pwd()

    def ls(self, path: str = ".", max_entries: int = 100) -> dict:
        max_entries = max(1, min(int(max_entries), 500))
        target = self._resolve(path)
        if not target.exists():
            raise SandboxError(f"path does not exist: {path}")
        if target.is_file():
            return {"path": self._rel(target), "type": "file", "size": target.stat().st_size}
        rows = []
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))[:max_entries]:
            rows.append({
                "name": child.name,
                "path": self._rel(child),
                "type": "dir" if child.is_dir() else "file",
                "size": None if child.is_dir() else child.stat().st_size,
            })
        return {"path": self._rel(target), "entries": rows}

    def read_file(self, path: str, max_bytes: int = 20000) -> dict:
        max_bytes = max(1, min(int(max_bytes), 200000))
        target = self._resolve(path)
        if not target.is_file():
            raise SandboxError(f"not a file: {path}")
        data = target.read_bytes()
        truncated = len(data) > max_bytes
        chunk = data[:max_bytes]
        text = chunk.decode("utf-8", errors="replace")
        return {"path": self._rel(target), "bytes": len(data), "truncated": truncated, "content": text}

    def write_file(self, path: str, content: str, mode: str = "overwrite") -> dict:
        target = self._resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if mode not in {"overwrite", "append"}:
            raise SandboxError("mode must be overwrite or append")
        if mode == "append":
            with target.open("a", encoding="utf-8", newline="") as fh:
                fh.write(content)
        else:
            target.write_text(content, encoding="utf-8", newline="")
        return {"path": self._rel(target), "bytes": target.stat().st_size, "mode": mode}

    def mkdir(self, path: str) -> dict:
        target = self._resolve(path)
        target.mkdir(parents=True, exist_ok=True)
        return {"path": self._rel(target)}

    def replace_text(self, path: str, old: str, new: str, count: int = 1) -> dict:
        target = self._resolve(path)
        if not target.is_file():
            raise SandboxError(f"not a file: {path}")
        text = target.read_text(encoding="utf-8", errors="replace")
        count = int(count)
        if count < 0:
            count = -1
        occurrences = text.count(old)
        if occurrences == 0:
            raise SandboxError("old text not found")
        updated = text.replace(old, new, count if count != -1 else occurrences)
        target.write_text(updated, encoding="utf-8", newline="")
        return {"path": self._rel(target), "replaced": min(occurrences, count if count != -1 else occurrences)}

    def run_powershell(self, command: str, timeout: int = 60) -> dict:
        if len(command) > 2000:
            raise SandboxError("command is too long")
        for pattern, reason in BLOCKED_SHELL_PATTERNS:
            if pattern.search(command):
                raise SandboxError(reason)
        timeout = max(1, min(int(timeout), 300))

        if self.approval_mode != "never":
            print("\nCommand requested inside sandbox:")
            print(f"  cwd: {self._rel(self.cwd)}")
            print(f"  ps> {command}")
            answer = input("Run it? [y/N] ").strip().lower()
            if answer not in {"y", "yes", "t", "tak"}:
                raise SandboxError("user rejected shell command")

        env = {
            "PATH": os.environ.get("PATH", ""),
            "SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"),
            "TEMP": str(self.tmp),
            "TMP": str(self.tmp),
            "BIELIK_SANDBOX_ROOT": str(self.root),
        }
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            cwd=str(self.cwd),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
        return {
            "cwd": self._rel(self.cwd),
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-20000:],
            "stderr": proc.stderr[-20000:],
        }


def post_chat(base_url: str, model: str, messages: list[dict], temperature: float, max_tokens: int) -> str:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        raise RuntimeError(f"cannot reach model server at {url}: {exc}") from exc
    return body["choices"][0]["message"]["content"]


def extract_first_json_object(text: str) -> str | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def parse_action(text: str) -> dict | None:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        obj = extract_first_json_object(cleaned)
        if obj:
            try:
                return json.loads(obj)
            except json.JSONDecodeError:
                return None
        return None


def call_tool(sandbox: Sandbox, action: dict) -> dict:
    tool = action.get("tool")
    args = action.get("args") or {}
    if not isinstance(args, dict):
        raise SandboxError("args must be an object")

    tools = {
        "pwd": sandbox.pwd,
        "cd": sandbox.cd,
        "ls": sandbox.ls,
        "read_file": sandbox.read_file,
        "write_file": sandbox.write_file,
        "mkdir": sandbox.mkdir,
        "replace_text": sandbox.replace_text,
        "run_powershell": sandbox.run_powershell,
    }
    if tool not in tools:
        raise SandboxError(f"unknown tool: {tool}")
    return tools[tool](**args)


def compact_messages(messages: list[dict], keep: int = 30) -> list[dict]:
    if len(messages) <= keep:
        return messages
    return [messages[0]] + messages[-(keep - 1):]


def main() -> int:
    parser = argparse.ArgumentParser(description="Local sandbox coding agent")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8088/v1")
    parser.add_argument("--model", default="qwen2.5-coder-14b-instruct-q4_k_m")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--max-tokens", type=int, default=1024)
    parser.add_argument("--max-steps", type=int, default=12)
    parser.add_argument("--approval-mode", choices=["on-shell", "never"], default="on-shell")
    args = parser.parse_args()

    sandbox = Sandbox(Path(args.workspace), args.approval_mode)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    print("Local sandbox coding agent ready.")
    print(f"Root: {sandbox.root}")
    print("Commands: /exit, /pwd, /clear")

    while True:
        try:
            user = input("\nTy> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if not user:
            continue
        if user in {"/exit", "/quit"}:
            return 0
        if user == "/pwd":
            print(json.dumps(sandbox.pwd(), ensure_ascii=False, indent=2))
            continue
        if user == "/clear":
            messages = [{"role": "system", "content": SYSTEM_PROMPT}]
            print("Conversation cleared.")
            continue

        messages.append({"role": "user", "content": user})
        for _ in range(args.max_steps):
            messages = compact_messages(messages)
            started = time.time()
            try:
                content = post_chat(args.base_url, args.model, messages, args.temperature, args.max_tokens)
            except Exception as exc:
                print(f"Model error: {exc}")
                break

            action = parse_action(content)
            if not action:
                print("\nModel returned non-JSON output:")
                print(textwrap.shorten(content.replace("\n", " "), width=1200, placeholder=" ..."))
                messages.append({"role": "assistant", "content": content})
                break

            if "final" in action:
                print("\nModel>", action["final"])
                messages.append({"role": "assistant", "content": json.dumps(action, ensure_ascii=False)})
                break

            print(f"\nModel action ({time.time() - started:.1f}s): {action.get('tool')}")
            messages.append({"role": "assistant", "content": json.dumps(action, ensure_ascii=False)})

            try:
                result = call_tool(sandbox, action)
                tool_message = {"ok": True, "result": result}
            except Exception as exc:
                tool_message = {"ok": False, "error": str(exc)}

            pretty = json.dumps(tool_message, ensure_ascii=False, indent=2)
            print(pretty[:4000])
            messages.append({
                "role": "user",
                "content": "Wynik narzedzia. Kontynuuj prace albo zakoncz przez final:\n" + pretty,
            })
        else:
            print("Step limit reached; ask me to continue if needed.")


if __name__ == "__main__":
    raise SystemExit(main())
