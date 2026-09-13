// test/tryout/stubs.js — seeds require.cache so the modules under test get
// in-memory stand-ins for the database, Roblox and the evasion record instead
// of reaching the network. Call installStubs() BEFORE requiring the module.
'use strict';

const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'server', 'lib');

function seed(name, exports) {
  const resolved = require.resolve(path.join(LIB, name));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// state is mutated per test, so one require of the module under test serves all.
const state = {
  portalUsers: [],        // rows keyed by robloxId
  otherRoblox: [],        // rows keyed by discordId, used for the alt lookup
  rover: [],              // RoVer reverse lookup result
  groupRole: null,        // MET group membership, null means not a member
  blacklistSources: [],
  blacklistDegraded: [],       // which blacklist lookups could not be read
  portalThrows: false,
  roverThrows: false,
};

function reset(over) {
  Object.assign(state, {
    portalUsers: [], otherRoblox: [], rover: [], groupRole: null,
    blacklistSources: [], blacklistDegraded: [], portalThrows: false, roverThrows: false,
  }, over || {});
}

function installStubs() {
  seed('db.js', {
    user: {
      async findMany(q) {
        if (state.portalThrows) throw new Error('ECONNREFUSED');
        // The alt lookup is the one that filters on discordId.
        return (q && q.where && q.where.discordId) ? state.otherRoblox : state.portalUsers;
      },
      async findFirst() { return null; },
    },
  });

  seed('roblox.js', {
    async getRobloxUserInfo() { return { username: 'realangeloo' }; },
    async getDiscordFromRoblox() {
      if (state.roverThrows) throw new Error('rover unreachable');
      return state.rover;
    },
    async getUserGroupRole() { return state.groupRole; },
    async listJoinRequests() { throw new Error('no group cookie configured'); },
  });

  seed('evasion.js', {
    async gatherRecord() {
      // degraded names the lookups that could not be read. A non empty degraded
      // means "no sources found" is the absence of an answer, not a clean one.
      return { blacklistSources: state.blacklistSources, otherAccounts: [], degraded: state.blacklistDegraded };
    },
  });
}

module.exports = { installStubs, state, reset };
