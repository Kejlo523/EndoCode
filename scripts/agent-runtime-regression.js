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

  const patchEdit = validateAction(
    { tool: "patch_edit", args: { path: "index.html", search: "<h1>Old</h1>", replace: "<h1>New</h1>" } },
    { intentClass: fileIntent },
  );
  assert(patchEdit.ok, "patch_edit should be allowed for filesystem intent");

  const patchBatchMissing = validateAction(
    { tool: "patch_batch", args: {} },
    { intentClass: fileIntent },
  );
  assert(!patchBatchMissing.ok, "patch_batch should require patch or blocks");

  const patchBatchOk = validateAction(
    { tool: "patch_batch", args: { patch: "index.html\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n" } },
    { intentClass: fileIntent },
  );
  assert(patchBatchOk.ok, "patch_batch should accept patch input");

  const malformed = validateAction("not-an-object", { intentClass: "general" });
  assert(!malformed.ok && malformed.errorCode === "action_not_object", "Expected malformed action rejection");

  console.log("Agent runtime regression checks: OK");
}

run();

