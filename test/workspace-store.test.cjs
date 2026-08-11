const assert = require("node:assert/strict");
const test = require("node:test");

const { WorkspaceStore } = require("../dist/storage/workspace-store");

const legacyState = (version) => ({
  version,
  workspaceRoot: "/repo",
  repositoryRoot: "/repo",
  baselineCommit: "abc123",
  startedAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  paused: false,
  planCandidates: [],
  agentFiles: [],
  changedFiles: [],
  findings: [],
  verification: [],
  trustedCommandHashes: [],
  agent: { connectedAgents: ["codex"] },
  teamActivity: { sessions: [{ sessionId: "legacy" }], attributionCapable: true },
});

class Memento {
  constructor(entries) { this.entries = new Map(entries); }
  get(key) { return this.entries.get(key); }
  async update(key, value) {
    if (value === undefined) this.entries.delete(key);
    else this.entries.set(key, value);
  }
}

for (const version of [7, 8]) {
  test(`v${version} migration drops retired monitoring state before saving v9`, async () => {
    const memento = new Memento([[`vibecheck.observationState.v${version}`, legacyState(version)]]);
    const store = new WorkspaceStore(memento);
    const migrated = store.getObservation();

    assert.equal(migrated.version, 9);
    assert.equal(Object.hasOwn(migrated, "agent"), false);
    assert.equal(Object.hasOwn(migrated, "teamActivity"), false);

    await store.saveObservation(migrated);
    const saved = memento.get("vibecheck.observationState.v9");
    assert.equal(Object.hasOwn(saved, "agent"), false);
    assert.equal(Object.hasOwn(saved, "teamActivity"), false);
    assert.equal(memento.get(`vibecheck.observationState.v${version}`), undefined);
  });
}
