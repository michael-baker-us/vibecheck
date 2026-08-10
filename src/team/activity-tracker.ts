/**
 * Reconstructs per-session team activity from the hook bridge's lifecycle events.
 *
 * This is a pure reducer with an injected clock, so every timing rule below is testable without
 * waiting. It records only metadata: which session, which provider, which roster member the most
 * recent delegation named, which tool ran last, and when. What a session was asked to do, and what
 * it produced, are never observable through this channel — by design, not by omission.
 */

import { AgentEvent } from "../domain/agent-events";
import {
  EMPTY_TEAM_ACTIVITY,
  TeamActivity,
  TeamSessionActivity,
  TeamSessionStatus,
} from "../domain/team";

/** Sessions that crash or are killed never emit `session-end`, so liveness decays on its own. */
export const IDLE_AFTER_MS = 5 * 60 * 1000;
export const ENDED_AFTER_MS = 60 * 60 * 1000;

/** Bounds persisted state; the panel shows recent work, not an audit log. */
const MAX_SESSIONS = 20;

/**
 * Folds one event into the activity state.
 *
 * `rosterIds` is the semantic half of the two-stage bound on delegation attribution: the bridge
 * accepts only identifier-shaped values, and anything not naming a configured member is dropped
 * here before it can reach workspace state.
 */
export function applyAgentEvent(
  activity: TeamActivity,
  event: AgentEvent,
  rosterIds: ReadonlySet<string>,
  now: number,
): TeamActivity {
  const attributionCapable = activity.attributionCapable || event.version >= 2;
  if (!event.sessionId || event.agent === "unknown") {
    return attributionCapable === activity.attributionCapable
      ? activity
      : { ...activity, attributionCapable };
  }

  const existing = activity.sessions.find((session) => session.sessionId === event.sessionId);
  const named = event.member && rosterIds.has(event.member) ? event.member : undefined;
  // A delegation names the member; later events in the same session inherit it until the subagent
  // stops, at which point the session is back to its primary work.
  const member = resolveMember(existing, named, event.type);
  const lastTool = toolFor(existing, event);
  const next: TeamSessionActivity = {
    sessionId: event.sessionId,
    agent: event.agent,
    ...(member ? { member } : {}),
    status: statusFor(event.type),
    startedAt: existing?.startedAt ?? event.at,
    lastEventAt: event.at,
    ...(lastTool ? { lastTool } : {}),
    toolCount: (existing?.toolCount ?? 0) + (event.type === "tool-finished" ? 1 : 0),
  };

  const sessions = [next, ...activity.sessions.filter((session) => session.sessionId !== event.sessionId)]
    .slice(0, MAX_SESSIONS);
  return { sessions: decay(sessions, now), attributionCapable };
}

/**
 * Re-evaluates liveness without a new event, so a session that simply stopped emitting fades to
 * idle and then ended rather than appearing to run forever.
 */
export function decayActivity(activity: TeamActivity, now: number): TeamActivity {
  const sessions = decay(activity.sessions, now);
  return sessions.every((session, index) => session.status === activity.sessions[index].status)
    ? activity
    : { ...activity, sessions };
}

/** Drops attribution for members that are no longer on the roster. */
export function reconcileActivity(activity: TeamActivity, rosterIds: ReadonlySet<string>): TeamActivity {
  const sessions = activity.sessions.map((session) =>
    session.member && !rosterIds.has(session.member)
      ? { ...session, member: undefined }
      : session);
  return sessions.some((session, index) => session.member !== activity.sessions[index].member)
    ? { ...activity, sessions }
    : activity;
}

export function emptyActivity(): TeamActivity {
  return EMPTY_TEAM_ACTIVITY;
}

function decay(sessions: TeamSessionActivity[], now: number): TeamSessionActivity[] {
  return sessions.map((session) => {
    if (session.status === "ended") return session;
    const silent = now - Date.parse(session.lastEventAt);
    if (Number.isNaN(silent)) return session;
    if (silent >= ENDED_AFTER_MS) return { ...session, status: "ended" as const };
    if (silent >= IDLE_AFTER_MS) return { ...session, status: "idle" as const };
    return session;
  });
}

function statusFor(type: AgentEvent["type"]): TeamSessionStatus {
  return type === "session-end" ? "ended" : "active";
}

function resolveMember(
  existing: TeamSessionActivity | undefined,
  member: string | undefined,
  type: AgentEvent["type"],
): string | undefined {
  if (type === "subagent-stop" || type === "session-end") return undefined;
  return member ?? existing?.member;
}

function toolFor(existing: TeamSessionActivity | undefined, event: AgentEvent): string | undefined {
  if (event.type === "tool-started" || event.type === "tool-finished") return event.tool ?? existing?.lastTool;
  return existing?.lastTool;
}
