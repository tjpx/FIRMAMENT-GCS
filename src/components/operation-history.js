const KEY = 'fmt.operation-history'
const MAX = 100
function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] } }
export function recordOperation(operation) { const rows = read(); rows.unshift({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, at: new Date().toISOString(), ...operation }); localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX))); return rows[0] }
export function operationHistory() { return read() }
export function clearOperationHistory() { localStorage.removeItem(KEY) }
