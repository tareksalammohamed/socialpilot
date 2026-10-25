export const calls = [];
export const session = { user: { id: 'user-1', email: 'qa@example.test' }, access_token: 'qa-token' };
export let dnaError = false;
let enqueueError = false, listener;
let tasks = [];
const channels = new Set();
export function setDnaError(value) { dnaError = value; }
export function setEnqueueError(value) { enqueueError = value; }
export function enableAutoAnalyze() { ws.settings = { inbox_ai: { enabled: true, autoAnalyze: true } }; }
const ws = { id: 'workspace-1', owner_id: 'user-1', name: 'QA', settings: {} };
export const conversations = ['a', 'b'].map((id, i) => ({ id, workspace_id: ws.id, platform: 'whatsapp', type: 'dm', sender_name: 'عميل ' + (i + 1), status: 'open', unread: false, metadata: { provider: i ? 'wppconnect' : 'waha' }, updated_at: new Date(Date.now() - i * 1000).toISOString() }));
let inboxConversations = conversations;
let inboxMessages = null;
const deferred = [];
export function setInboxData(rows, messages) { inboxConversations = rows; inboxMessages = messages; }
export function deferRead(table, matches = () => true) {
  const gate = { table, matches, release: null }; deferred.push(gate); return gate;
}
export function emitInbox(table, payload) {
  for (const channel of channels) for (const entry of channel.inboxCallbacks) if (entry.table === table) entry.callback(payload);
}
export const contentRows = Array.from({ length: 73 }, (_, index) => ({
  id: `content-${index}`, workspace_id: ws.id, title: `منشور رقم ${index}`, master_text: `نص ${index}`,
  status: ['published', 'review', 'draft'][index % 3], quality_status: 'passed', platforms: ['facebook'],
  created_at: new Date(Date.now() - index * 60000).toISOString(),
}));
const calendarRows = [{
  id: 'calendar-visible', workspace_id: ws.id, variant_id: 'variant-70', content_id: 'content-70',
  status: 'scheduled', platform: 'facebook', scheduled_for: new Date().toISOString(),
  content: contentRows[70],
}, {
  id: 'calendar-future', workspace_id: ws.id, variant_id: 'variant-future', content_id: 'content-71',
  status: 'scheduled', platform: 'facebook', scheduled_for: new Date(Date.now() + 60 * 86400000).toISOString(),
  content: contentRows[71],
}];
export function emitTasks(next) {
  tasks = next;
  for (const channel of channels) for (const callback of channel.callbacks) callback({ new: next[0] ?? {}, eventType: 'UPDATE' });
}

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: fn => { listener = fn; return { data: { subscription: { unsubscribe() { listener = null; } } } }; },
    signOut: async () => { listener('SIGNED_OUT', null); },
  },
  async rpc(name) {
    calls.push({ table: name });
    return { data: name === 'is_super_admin' ? false : null, error: name === 'enqueue_assistant_task' && enqueueError ? { message: 'تعذّر حفظ المهمة' } : null };
  },
  from(table) {
    let single = false;
    const query = {}, args = [];
    for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'in', 'gte', 'lt', 'update', 'range', 'ilike', 'or', 'abortSignal']) {
      query[method] = (...a) => { args.push([method, ...a]); return query; };
    }
    query.maybeSingle = query.single = () => { single = true; return query; };
    query.then = (resolve, reject) => {
      calls.push({ table, args }); let data, count = 0;
      if (table === 'workspace_members') data = { workspace_id: ws.id };
      else if (table === 'workspaces') data = ws;
      else if (table === 'brand_dna') data = dnaError ? null : { id: 'dna', status: 'approved' };
      else if (table === 'assistant_tasks') data = single ? tasks[0] ?? null : tasks;
      else if (table === 'inbox_conversations' || table === 'inbox_messages') {
        const conversationId = args.find(a => a[0] === 'eq' && a[1] === 'conversation_id')?.[2] ?? 'a';
        let rows = table === 'inbox_conversations' ? [...inboxConversations] : inboxMessages ? [...inboxMessages] : [
          { id: 'latest', conversation_id: conversationId, workspace_id: ws.id, direction: 'inbound', content: 'أحدث رسالة', created_at: '2026-10-24T10:00:00Z', metadata: {} },
          { id: 'older', conversation_id: conversationId, workspace_id: ws.id, direction: 'inbound', content: 'رسالة أقدم', created_at: '2026-10-20T10:00:00Z', metadata: {} },
        ];
        for (const [method, field, value] of args) {
          if (method === 'eq') rows = rows.filter(row => row[field] === value);
          if (method === 'neq') rows = rows.filter(row => row[field] !== value);
          if (method === 'in') rows = rows.filter(row => value.includes(row[field]));
          if (method === 'or' && field.startsWith('sender_name.ilike.')) {
            const match = field.match(/^sender_name\.ilike\.("(?:[^"\\]|\\.)*"),snippet\.ilike\.("(?:[^"\\]|\\.)*")$/);
            if (!match) throw Error('Invalid quoted conversation search: '+field);
            const term = JSON.parse(match[1]).slice(1,-1).replace(/\\([\\%_])/g,'$1').toLowerCase();
            rows = rows.filter(row => [row.sender_name, row.snippet].some(text => String(text ?? '').toLowerCase().includes(term)));
          }
          if (method === 'or' && field.startsWith('created_at.lt.')) {
            const match = field.match(/^created_at\.lt\.("(?:[^"\\]|\\.)*"),and\(created_at\.eq\.("(?:[^"\\]|\\.)*"),id\.lt\.("(?:[^"\\]|\\.)*")\)$/);
            if (!match) throw Error('Invalid message cursor: '+field);
            const timestamp = JSON.parse(match[1]), id = JSON.parse(match[3]);
            rows = rows.filter(row => row.created_at < timestamp || row.created_at === timestamp && row.id < id);
          }
        }
        const update = args.find(a => a[0] === 'update');
        if (update && table === 'inbox_conversations') {
          const ids = new Set(rows.map(row => row.id));
          inboxConversations = inboxConversations.map(row => ids.has(row.id) ? { ...row, ...update[1] } : row);
        }
        const orders = args.filter(a => a[0] === 'order');
        rows.sort((a,b) => { for (const [, field, order] of orders) { if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (order.ascending ? 1 : -1); } return 0; });
        count = rows.length;
        const range = args.find(a => a[0] === 'range'), limit = args.find(a => a[0] === 'limit');
        if (range) rows = rows.slice(range[1], range[2] + 1);
        if (limit) rows = rows.slice(0, limit[1]);
        data = single ? rows[0] ?? null : rows;
        if (args.some(a => a[0] === 'select' && a[2]?.head)) data = null;
      }
      else if (table === 'content' || table === 'calendar_items') {
        let rows = table === 'content' ? [...contentRows] : [...calendarRows];
        for (const [method, field, value] of args) {
          if (method === 'eq') rows = rows.filter(row => row[field] === value);
          if (method === 'neq') rows = rows.filter(row => row[field] !== value);
          if (method === 'in') rows = rows.filter(row => value.includes(row[field]));
          if (method === 'gte') rows = rows.filter(row => row[field] >= value);
          if (method === 'lt') rows = rows.filter(row => row[field] < value);
          if (method === 'ilike') rows = rows.filter(row => row[field].includes(value.slice(1, -1).replace(/\\([\\%_])/g, '$1')));
          if (method === 'or') rows = rows.filter(row => row.status === 'review' || row.quality_status === 'needs_improvement');
        }
        count = rows.length;
        const range = args.find(a => a[0] === 'range');
        if (range) rows = rows.slice(range[1], range[2] + 1);
        data = single ? rows[0] ?? null : rows;
        if (args.some(a => a[0] === 'select' && a[2]?.head)) data = null;
      }
      else data = single ? null : [];
      const result = { data, error: table === 'brand_dna' && dnaError ? { message: 'offline' } : null, count };
      const index = deferred.findIndex(gate => gate.table === table && !args.some(a => a[0] === 'update') && gate.matches(args));
      if (index >= 0) { const gate = deferred.splice(index, 1)[0]; return new Promise(release => { gate.release = () => release(result); }).then(resolve, reject); }
      return Promise.resolve(result).then(resolve, reject);
    };
    return query;
  },
  channel() {
    const channel = { callbacks: [], inboxCallbacks: [], on: (_event, filter, callback) => { if (filter.table === 'assistant_tasks') channel.callbacks.push(callback); else channel.inboxCallbacks.push({ table: filter.table, callback }); return channel; }, subscribe: () => channel };
    channels.add(channel); return channel;
  },
  removeChannel: async channel => { channels.delete(channel); },
};
export function emit(event, next = session) { listener(event, next); }
