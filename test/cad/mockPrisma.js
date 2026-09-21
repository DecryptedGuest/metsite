// test/cad/mockPrisma.js — a tiny in-memory Prisma stand-in for the CAD service
// tests. Supports the query shapes the services use: equality, {not}, {in},
// {startsWith}, {endsWith}, {contains}, {equals}, and OR/AND. No real DB.
'use strict';

function matchCond(value, cond) {
  if (cond === null || typeof cond !== 'object') return value === cond;
  if ('not' in cond) return value !== cond.not;
  if ('in' in cond) return Array.isArray(cond.in) && cond.in.includes(value);
  if ('startsWith' in cond) return typeof value === 'string' && value.startsWith(cond.startsWith);
  if ('endsWith' in cond) return typeof value === 'string' && value.endsWith(cond.endsWith);
  if ('contains' in cond) return typeof value === 'string' && value.toLowerCase().includes(String(cond.contains).toLowerCase());
  if ('equals' in cond) return typeof value === 'string' ? value.toLowerCase() === String(cond.equals).toLowerCase() : value === cond.equals;
  return false;
}
function matchWhere(row, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') { if (!(Array.isArray(v) && v.some(w => matchWhere(row, w)))) return false; continue; }
    if (k === 'AND') { if (!(Array.isArray(v) && v.every(w => matchWhere(row, w)))) return false; continue; }
    if (!matchCond(row[k], v)) return false;
  }
  return true;
}

let seq = 0;
function model(store) {
  return {
    _store: store,
    async findUnique({ where }) { return clone(store.find(r => matchWhere(r, where))); },
    async findFirst({ where } = {}) { return clone(store.find(r => matchWhere(r, where || {}))); },
    async findMany({ where, select, orderBy } = {}) {
      let rows = store.filter(r => matchWhere(r, where || {}));
      if (select) rows = rows.map(r => { const o = {}; for (const k of Object.keys(select)) o[k] = r[k]; return o; });
      return rows.map(clone);
    },
    async count({ where } = {}) { return store.filter(r => matchWhere(r, where || {})).length; },
    async create({ data }) {
      const row = { id: data.id || `id-${++seq}`, createdAt: new Date(), ...data };
      store.push(row); return clone(row);
    },
    async update({ where, data }) {
      const row = store.find(r => matchWhere(r, where));
      if (!row) { const e = new Error('Record not found'); e.code = 'P2025'; throw e; }
      Object.assign(row, data); return clone(row);
    },
    async updateMany({ where, data } = {}) {
      const rows = store.filter(r => matchWhere(r, where || {}));
      rows.forEach(r => Object.assign(r, data)); return { count: rows.length };
    },
    async upsert({ where, create, update }) {
      const row = store.find(r => matchWhere(r, where));
      if (row) { Object.assign(row, update); return clone(row); }
      const nr = { id: `id-${++seq}`, ...create }; store.push(nr); return clone(nr);
    },
  };
}
function clone(r) { return r ? JSON.parse(JSON.stringify(r)) : null; }

function makeMockPrisma() {
  return {
    cadUnit: model([]),
    cadIncident: model([]),
    cadIncidentLog: model([]),
    cadVehicleRecord: model([]),
    cadPersonRecord: model([]),
  };
}

module.exports = { makeMockPrisma, matchWhere };
