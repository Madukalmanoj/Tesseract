// ChatExtract Pro v3.3 — Background Service Worker

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // Debug: test a single fileId and return raw API response
  if (req.action === "debugChatGPTFile") {
    (async () => {
      try {
        const r1 = await fetch("https://chatgpt.com/backend-api/files/" + req.fileId + "/download", {
          credentials: "include", headers: { "accept": "application/json" }
        });
        const text = await r1.text();
        sendResponse({ status: r1.status, body: text });
      } catch(e) { sendResponse({ error: e.message }); }
    })();
    return true;
  }
  if (req.action === "fetchAsBase64") {
    fetchAsBase64(req.url).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (req.action === "fetchChatGPTFile") {
    fetchChatGPTFile(req.fileId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (req.action === "llmRefine") {
    handleLLMRefine(req).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (req.action === "downloadDataUrl") {
    chrome.downloads.download({ url: req.dataUrl, filename: req.filename, saveAs: false },
      id => sendResponse({ ok: true, id }));
    return true;
  }
  if (req.action === "downloadText") {
    const blob = new Blob([req.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: req.filename, saveAs: false }, id => {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      sendResponse({ ok: true, id });
    });
    return true;
  }
  if (req.action === "downloadJson") {
    const blob = new Blob([req.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: req.filename, saveAs: false }, id => {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      sendResponse({ ok: true, id });
    });
    return true;
  }
});

// ── Fetch any URL as base64 ───────────────────────────────────────────────────
async function fetchAsBase64(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const ct = res.headers.get("content-type") || "application/octet-stream";
  return { dataUrl: "data:" + ct + ";base64," + base64, mimeType: ct, size: bytes.length };
}

// ── MIME to extension ─────────────────────────────────────────────────────────
function mimeToExt(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("pdf"))                return "pdf";
  if (m.includes("zip"))                return "zip";
  if (m.includes("msword"))             return "doc";
  if (m.includes("wordprocessingml"))   return "docx";
  if (m.includes("spreadsheetml"))      return "xlsx";
  if (m.includes("presentationml"))     return "pptx";
  if (m.includes("text/plain"))         return "txt";
  if (m.includes("csv"))                return "csv";
  if (m.includes("json"))               return "json";
  if (m.includes("png"))                return "png";
  if (m.includes("jpeg"))               return "jpg";
  if (m.includes("gif"))                return "gif";
  if (m.includes("webp"))               return "webp";
  return null;
}

// ── Extract filename from signed URL ─────────────────────────────────────────
function filenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);

    // Check rscd / response-content-disposition query param (Azure/S3 pattern)
    const rscd = u.searchParams.get("rscd") ||
                 u.searchParams.get("response-content-disposition") || "";
    if (rscd) {
      // filename*=UTF-8''foo%20bar.docx (RFC 5987)
      const m1 = rscd.match(/filename\*=UTF-8''([^;&]+)/i);
      if (m1) return decodeURIComponent(m1[1]).trim();
      // filename="foo.docx" or filename=foo.docx
      const m2 = rscd.match(/filename=([^;&]+)/i);
      if (m2) return decodeURIComponent(m2[1]).replace(/["']/g, "").trim();
    }

    // Last path segment that looks like a real filename
    const segs = u.pathname.split("/").filter(Boolean);
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(segs[i]);
      const looksLikeFile = seg.includes(".") &&
                            seg !== "download" &&
                            seg.length < 200 &&
                            !/^[a-f0-9\-]{20,}$/.test(seg) &&
                            !/^\d+$/.test(seg);
      if (looksLikeFile) return seg;
    }
  } catch (_) {}
  return null;
}

// ── ChatGPT file download ─────────────────────────────────────────────────────
// Response shape from /backend-api/files/{id}/download:
// { status:"success", file_name:"foo.docx", file_size_bytes:1234,
//   download_url:"https://chatgpt.com/backend-api/estuary/content?...", ... }
async function fetchChatGPTFile(fileId) {
  // Step 1: get signed download URL + filename from download endpoint
  const dlRes = await fetch("https://chatgpt.com/backend-api/files/" + fileId + "/download", {
    credentials: "include",
    headers: { "accept": "application/json" }
  });
  if (!dlRes.ok) throw new Error("download-meta HTTP " + dlRes.status);
  const dlMeta = await dlRes.json();

  // LOG: send full response back so we can see exact field names
  console.log("[CEP] /download response for", fileId, JSON.stringify(dlMeta));

  // Try every possible field name ChatGPT might use
  const metaFilename = dlMeta.file_name || dlMeta.fileName || dlMeta.filename ||
                       dlMeta.name || dlMeta.original_filename || dlMeta.original_name || null;
  const downloadUrl  = dlMeta.download_url || dlMeta.downloadUrl || dlMeta.url || null;
  if (!downloadUrl) throw new Error("no download_url — full response: " + JSON.stringify(dlMeta));

  // Step 2: fetch the actual blob (download_url may be chatgpt.com or oaiusercontent.com)
  const blobRes = await fetch(downloadUrl, { credentials: "include" });
  if (!blobRes.ok) throw new Error("blob HTTP " + blobRes.status);
  const ct = blobRes.headers.get("content-type") || "application/octet-stream";
  const buffer = await blobRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);

  // Step 3: resolve best filename
  // Priority: API field > URL extraction > mime fallback
  let filename = metaFilename || filenameFromUrl(downloadUrl) || null;
  if (!filename) {
    filename = fileId + "." + (mimeToExt(ct) || "bin");
  } else if (!filename.includes(".")) {
    const ext = mimeToExt(ct);
    if (ext) filename = filename + "." + ext;
  }

  return { dataUrl: "data:" + ct + ";base64," + base64, mimeType: ct, filename, size: bytes.length };
}

// ── LLM API router ────────────────────────────────────────────────────────────
async function handleLLMRefine({ provider, apiKey, chatText, capsuleName }) {
  const system = `You are a master prompt engineer. Your task is to transform the provided raw chat transcript into a highly dense, reusable 'Context Capsule'.
The goal of this capsule is to allow a user to drop it into a NEW AI chat session to perfectly resume work.

CRITICAL RULES:
1. DO NOT SUMMARIZE AWAY OR OMIT ANY DETAILS. Your goal is high information density, not compression by omission. Every single valuable detail, fact, name, score, timeline, number, code snippet, configuration, preference, and personal background detail mentioned in the transcript MUST be preserved in full.
2. PRESERVE the current state of the project (e.g., current score, bugs being fixed, next steps).
3. PRESERVE the user's name, identity, and personal background details if mentioned in the transcript, so the new AI session knows exactly who it is interacting with.
4. Structure the capsule logically:
   - # Context Capsule: [Name]
   - ## Project Goal: [1-2 sentences]
   - ## Current State & Metrics: [What has been achieved so far]
   - ## Technical Foundation: [Preserve critical code, libraries, and architecture]
   - ## Task to Continue: [What the AI needs to do next]
5. Do not include introductory or conversational filler. Output the capsule directly.`;
  const user = `Capsule name: "${capsuleName || 'Extracted Chat'}"\n\nRaw chat:\n---\n${chatText.slice(0, 32000)}\n---\n\nTransform this into a detailed context capsule that preserves all details, technical code, and state.`;
  if (provider === "anthropic") return callAnthropic(apiKey, system, user);
  if (provider === "groq")      return callGroq(apiKey, system, user);
  if (provider === "gemini")    return callGemini(apiKey, system, user);
  throw new Error("Unknown provider: " + provider);
}

async function callAnthropic(apiKey, system, userMsg) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model: "claude-opus-4-5", max_tokens: 2048, system, messages: [{ role: "user", content: userMsg }] })
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + ": " + await res.text());
  const d = await res.json();
  return { text: d.content && d.content[0] && d.content[0].text || "" };
}

async function callGroq(apiKey, system, userMsg) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 2048, messages: [{ role: "system", content: system }, { role: "user", content: userMsg }] })
  });
  if (!res.ok) throw new Error("Groq " + res.status + ": " + await res.text());
  const d = await res.json();
  return { text: d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "" };
}

async function callGemini(apiKey, system, userMsg) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userMsg }] }],
      generationConfig: { maxOutputTokens: 2048 }
    })
  });
  if (!res.ok) throw new Error("Gemini " + res.status + ": " + await res.text());
  const d = await res.json();
  return { text: d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text || "" };
}
