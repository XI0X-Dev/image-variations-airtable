import express from "express";
import fetch from "node-fetch";
import { URL } from "url";

/* ===================== CONFIG ===================== */
const {
  PORT = 10000,
  PUBLIC_BASE_URL,
  WAVESPEED_API_KEY,
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE = "Image Variations",
  WAVESPEED_BASE = "https://api.wavespeed.ai",
  WAVESPEED_SUBMIT_PATH = "/api/v3/bytedance/seedream-v4/edit-sequential",
  WAVESPEED_RESULT_PATH = "/api/v3/predictions",
} = process.env;

if (!PUBLIC_BASE_URL || !WAVESPEED_API_KEY || !AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
  console.error("[ERROR] Missing env vars");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));

console.log(`[CONF] Table: ${AIRTABLE_TABLE}`);

/* ===================== HELPERS ===================== */
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const nowISO = () => new Date().toISOString();

async function urlToDataURL(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/jpeg";
  return `data:${ct};base64,${buf.toString("base64")}`;
}

/* ===================== AIRTABLE ===================== */
const AT_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
const atHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" };

async function atGet(id) {
  const r = await fetch(`${AT_URL}/${id}`, { headers: atHeaders });
  if (!r.ok) throw new Error(`Airtable get failed: ${r.status}`);
  return r.json();
}

async function atPatch(id, fields) {
  const r = await fetch(`${AT_URL}/${id}`, {
    method: "PATCH",
    headers: atHeaders,
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`Airtable patch failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const mergeIds = (existing, newIds) => {
  const set = new Set((existing || "").split(",").map((s) => s.trim()).filter(Boolean));
  newIds.forEach((id) => set.add(String(id)));
  return [...set].join(", ");
};

const parseIds = (str) => new Set((str || "").split(",").map((s) => s.trim()).filter(Boolean));

async function markCompleted(recordId) {
  const rec = await atGet(recordId);
  const f = rec.fields || {};
  const req = parseIds(f["Request IDs"]);
  const seen = parseIds(f["Seen IDs"]);
  if (req.size > 0 && [...req].every((id) => seen.has(id))) {
    await atPatch(recordId, { Status: "completed", "Completed At": nowISO() });
  }
}

/* ===================== WAVESPEED ===================== */
const requestMap = new Map();

async function submitVariation({ prompt, imageDataUrl, width, height }, recordId) {
  const url = new URL(`${WAVESPEED_BASE}${WAVESPEED_SUBMIT_PATH}`);
  url.searchParams.set("webhook", `${PUBLIC_BASE_URL}/webhooks/wavespeed`);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WAVESPEED_API_KEY}`,
    },
    body: JSON.stringify({
      size: `${width}*${height}`,
      max_images: 1,
      enable_base64_output: false,
      enable_sync_mode: false,
      prompt: String(prompt || ""),
      negative_prompt: "text, watermark, logo, low quality",
      images: [imageDataUrl],
    }),
  });

  if (!res.ok) throw new Error(`Submit failed: ${res.status}`);
  const json = await res.json();
  const requestId = json?.data?.id || json?.id;
  if (!requestId) throw new Error("No request ID");
  requestMap.set(requestId, recordId);
  return requestId;
}

async function getResult(requestId) {
  const r = await fetch(`${WAVESPEED_BASE}${WAVESPEED_RESULT_PATH}/${requestId}/result`, {
    headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}` },
  });
  if (!r.ok) throw new Error(`Get result failed: ${r.status}`);
  const json = await r.json();
  const data = json.data || json;
  const status = (data.status || "processing").toLowerCase();
  let outputs = Array.isArray(data.output) ? data.output : Array.isArray(data.outputs) ? data.outputs : [];
  return { status, outputs };
}

async function appendOutputs(recordId, { outputs = [], requestId, failed = false }) {
  const rec = await atGet(recordId);
  const f = rec.fields || {};
  const prev = Array.isArray(f["Output"]) ? f["Output"] : [];
  const newOutputs = [...prev, ...outputs.map((url, i) => ({ url, filename: `var_${requestId}_${i}.png` }))];

  await atPatch(recordId, {
    Output: newOutputs,
    "Seen IDs": mergeIds(f["Seen IDs"], [requestId]),
    "Failed IDs": failed ? mergeIds(f["Failed IDs"], [requestId]) : f["Failed IDs"],
    "Last Update": nowISO(),
  });

  await markCompleted(recordId);
}

/* ===================== POLLING ===================== */
async function pollUntilDone(requestId, recordId) {
  const timeout = Date.now() + 20 * 60 * 1000;
  while (Date.now() < timeout) {
    try {
      const { status, outputs } = await getResult(requestId);
      console.log(`[POLL] ${requestId} -> ${status}`);

      if (["completed", "succeeded"].includes(status)) {
        await appendOutputs(recordId, { outputs, requestId, failed: false });
        return;
      }
      if (["failed", "error"].includes(status)) {
        await appendOutputs(recordId, { outputs: [], requestId, failed: true });
        return;
      }
      await sleep(7000);
    } catch (err) {
      console.error(`[POLL ERROR] ${requestId}:`, err.message);
      await appendOutputs(recordId, { outputs: [], requestId, failed: true });
      return;
    }
  }
  console.warn(`[TIMEOUT] ${requestId}`);
  await appendOutputs(recordId, { outputs: [], requestId, failed: true });
}

/* ===================== MAIN ===================== */
async function startVariations(recordId) {
  const rec = await atGet(recordId);
  const f = rec.fields || {};

  const prompt = String(f["Prompt"] || "");
  const subjectUrl = f["Subject"]?.[0]?.url || "";
  if (!prompt || !subjectUrl) throw new Error("Missing Prompt or Subject");

  let width = 1024, height = 1344;
  const sizeStr = String(f["Size"] || "");
  const m = sizeStr.match(/(\d+)\s*[xX*]\s*(\d+)/);
  if (m) { width = +m[1]; height = +m[2]; }

  const batchCount = Math.max(1, Math.min(10, Number(f["Batch Count"]) || 4));

  console.log(`[START] Record ${recordId}, ${batchCount} variations`);

  const imageDataUrl = await urlToDataURL(subjectUrl);

  await atPatch(recordId, {
    Status: "processing",
    "Request IDs": "",
    "Seen IDs": "",
    "Failed IDs": "",
    "Last Update": nowISO(),
    Model: "Seedream v4 (edit-sequential)",
    Size: `${width}x${height}`,
  });

  const requestIds = [];
  for (let i = 0; i < batchCount; i++) {
    try {
      const rid = await submitVariation({ prompt, imageDataUrl, width, height }, recordId);
      requestIds.push(rid);
      console.log(`[SUBMIT] ${i + 1}/${batchCount}: ${rid}`);
      if (i < batchCount - 1) await sleep(1200);
    } catch (err) {
      console.error(`[SUBMIT ERROR] ${i + 1}:`, err.message);
    }
  }

  await atPatch(recordId, { "Request IDs": requestIds.join(", ") });
  requestIds.forEach((rid) => pollUntilDone(rid, recordId).catch(console.error));

  return { recordId, submitted: requestIds.length, requestIds };
}

/* ===================== ROUTES ===================== */
app.get("/", (_, res) => res.send("Image Variations - Running"));

app.get("/airtable/run/:recordId", async (req, res) => {
  try {
    const result = await startVariations(req.params.recordId);
    res.send(`<html><body style="font-family:system-ui;padding:24px">
      <h2>✓ Started</h2>
      <p>Record: ${result.recordId}</p>
      <p>Submitted: ${result.submitted}</p>
      <p>Request IDs: ${result.requestIds.join(", ")}</p>
    </body></html>`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post("/webhooks/wavespeed", async (req, res) => {
  try {
    const b = req.body || {};
    const requestId = b.request_id || b.id;
    const status = (b.status || "").toLowerCase();
    const outputs = Array.isArray(b.output) ? b.output : [];
    const recordId = requestMap.get(requestId);

    if (!recordId) return res.status(202).json({ ok: false });

    if (["completed", "succeeded"].includes(status)) {
      await appendOutputs(recordId, { outputs, requestId, failed: false });
    } else if (["failed", "error"].includes(status)) {
      await appendOutputs(recordId, { outputs: [], requestId, failed: true });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] Running on port ${PORT}`);
  console.log(`[BOOT] Public URL: ${PUBLIC_BASE_URL}`);
});
