function createAgentPlanner(options = {}) {
  const {
    nextAction,
    getRepeatLimit,
    signatureForAction,
  } = options;

  if (typeof nextAction !== "function") throw new Error("createAgentPlanner requires nextAction");

  const actionCounts = new Map();

  function reset() {
    actionCounts.clear();
  }

  async function plan(signal, step, failedModelIds) {
    const { action, reasoning } = await nextAction(signal, failedModelIds, step);
    const signature = typeof signatureForAction === "function" ? signatureForAction(action) : JSON.stringify(action || {});
    const count = actionCounts.get(signature) || 0;
    const repeatLimit = typeof getRepeatLimit === "function" ? getRepeatLimit(action) : 2;
    const repeated = count >= repeatLimit;
    actionCounts.set(signature, count + 1);
    return { action, reasoning, repeated, repeatCount: count };
  }

  return { plan, reset };
}

module.exports = { createAgentPlanner };
