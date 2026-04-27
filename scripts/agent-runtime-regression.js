/* eslint-disable no-console */
"use strict";

const { classifyIntent, validateAction } = require("../app/src/main/agent/action-validator");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run() {
  const webIntent = classifyIntent("kto to jest latwogang, wyszukaj w internecie");
  assert(webIntent === "web", "Expected web intent for lookup query");

  const webBadTool = validateAction(
    { tool: "write_file", args: { path: "index.html", content: "<h1>x</h1>" } },
    { intentClass: webIntent },
  );
  assert(!webBadTool.ok && webBadTool.errorCode === "intent_mismatch", "write_file should be blocked for web intent");

  const webMissingUrl = validateAction(
    { tool: "fetch_url", args: {} },
    { intentClass: webIntent },
  );
  assert(!webMissingUrl.ok && webMissingUrl.errorCode === "missing_required_arg", "fetch_url should require url");

  const fileIntent = classifyIntent("zrob prosta strone html");
  assert(fileIntent === "filesystem", "Expected filesystem intent for html task");

  const htmlWrite = validateAction(
    { tool: "write_file", args: { path: "index.html", content: "<!doctype html>" } },
    { intentClass: fileIntent },
  );
  assert(htmlWrite.ok, "write_file should be allowed for filesystem intent");

  const malformed = validateAction("not-an-object", { intentClass: "general" });
  assert(!malformed.ok && malformed.errorCode === "action_not_object", "Expected malformed action rejection");

  console.log("Agent runtime regression checks: OK");
}

run();

