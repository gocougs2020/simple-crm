/**
 * Work for the agent was just started outside the chat (Enrich on a record,
 * say): the background task list reads again, so it follows the new task
 * and the page catches up when it finishes, with the panel closed too. The
 * panel loads only once it's needed, so a task list that mounts after the
 * news asks once on mount (`takeStarted`).
 */
const TASKS_CHANGED_EVENT = "crm:agent-tasks";
let started = false;

export function agentTasksChanged() {
  if (typeof window === "undefined") return;
  started = true;
  window.dispatchEvent(new Event(TASKS_CHANGED_EVENT));
}

export function onAgentTasksChanged(listener: () => void) {
  window.addEventListener(TASKS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(TASKS_CHANGED_EVENT, listener);
}

/** Whether work was started since the last time this was asked. */
export function takeStarted() {
  const was = started;
  started = false;
  return was;
}
