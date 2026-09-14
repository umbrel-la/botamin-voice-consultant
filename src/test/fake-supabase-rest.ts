type LeadRow = Record<string, unknown> & { id: string };
type ToolCallRow = { lead_id: string; call_id: string; result: unknown };
type JobRow = Record<string, unknown> & { lead_id: string };

export type FakeSupabase = {
  leads: Map<string, LeadRow>;
  toolCalls: Map<string, ToolCallRow>;
  jobs: Map<string, JobRow>;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eqValue(params: URLSearchParams, key: string) {
  const raw = params.get(key);
  if (!raw?.startsWith("eq.")) return null;
  return decodeURIComponent(raw.slice(3));
}

function toolKey(leadId: string, callId: string) {
  return `${leadId}:${callId}`;
}

export function createFakeSupabase() {
  const db: FakeSupabase = {
    leads: new Map(),
    toolCalls: new Map(),
    jobs: new Map(),
  };

  function handle(urlString: string, init?: RequestInit) {
    const url = new URL(urlString);
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;

    if (table === "leads") {
      const id = eqValue(url.searchParams, "id");
      if (method === "POST" && body) {
        const row = { ...body } as LeadRow;
        db.leads.set(row.id, row);
        return json(201, []);
      }
      if (method === "GET") {
        return json(200, id && db.leads.has(id) ? [db.leads.get(id)] : []);
      }
      if (method === "PATCH" && id && body) {
        const current = db.leads.get(id);
        if (!current) return json(200, []);
        const next = { ...current };
        for (const [key, value] of Object.entries(body)) {
          if (value !== undefined) next[key] = value;
        }
        db.leads.set(id, next);
        return json(200, []);
      }
    }

    if (table === "lead_tool_calls") {
      const leadId = eqValue(url.searchParams, "lead_id");
      const callId = eqValue(url.searchParams, "call_id");
      if (method === "GET") {
        if (!leadId || !callId) return json(200, []);
        const row = db.toolCalls.get(toolKey(leadId, callId));
        return json(200, row ? [row] : []);
      }
      if (method === "POST" && body) {
        const row = {
          lead_id: String(body.lead_id),
          call_id: String(body.call_id),
          result: body.result,
        };
        const key = toolKey(row.lead_id, row.call_id);
        if (db.toolCalls.has(key)) return json(409, { message: "duplicate" });
        db.toolCalls.set(key, row);
        return json(201, [row]);
      }
    }

    if (table === "notification_jobs") {
      const leadId = eqValue(url.searchParams, "lead_id");
      if (method === "POST" && body) {
        const row = { ...body, lead_id: String(body.lead_id) } as JobRow;
        db.jobs.set(row.lead_id, { ...db.jobs.get(row.lead_id), ...row });
        return json(201, []);
      }
      if (method === "GET") {
        if (leadId) return json(200, db.jobs.has(leadId) ? [db.jobs.get(leadId)] : []);
        return json(200, Array.from(db.jobs.values()));
      }
    }

    throw new Error(`Unhandled fake Supabase request ${method} ${urlString}`);
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith("https://fake.supabase.test/rest/v1/")) {
      throw new Error(`Unexpected fetch ${url}`);
    }
    return handle(url, init);
  };

  return { db, fetch: fetchImpl };
}
