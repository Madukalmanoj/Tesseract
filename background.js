// OmniExtract — Background Service Worker

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
    fetchChatGPTFile(req.fileId, req.authHeader, req.conversationId).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (req.action === "llmRefine") {
    handleLLMRefine(req).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (req.action === "testLLMKey") {
    handleLLMTest(req).then(sendResponse).catch(e => sendResponse({ error: e.message }));
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
  if (req.action === "openExtensionPopup") {
    if (chrome.action && typeof chrome.action.openPopup === "function") {
      chrome.action.openPopup()
        .then(() => sendResponse({ success: true }))
        .catch(e => {
          console.warn("[CEP] openPopup failed:", e);
          sendResponse({ success: false, error: e.message });
        });
    } else {
      sendResponse({ success: false, error: "chrome.action.openPopup not supported" });
    }
    return true;
  }
  if (req.action === "openPopupTab") {
    chrome.storage.local.get(["open_tab"]).then(res => {
      const hash = res.open_tab ? `#tab-${res.open_tab}` : "";
      chrome.windows.create({
        url: chrome.runtime.getURL(`popup/popup.html${hash}`),
        type: "popup",
        width: 380,
        height: 600
      }, () => {
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

// ── Fetch any URL as base64 ───────────────────────────────────────────────────
async function fetchAsBase64(url) {
  let res;

  // Custom fallback sequence for assets.grok.com
  if (url.includes('assets.grok.com') && url.endsWith('/content')) {
    const urlsToTry = [
      url, // /content
      url.replace(/\/content$/, '/original-image'),
      url.replace(/\/content$/, '/original'),
      url.replace(/\/content$/, '/image'),
      url.replace(/\/content$/, '/preview-image')
    ];

    for (let i = 0; i < urlsToTry.length; i++) {
      const attemptUrl = urlsToTry[i];
      try {
        res = await fetch(attemptUrl);
        if (res && res.ok) {
          url = attemptUrl; // update url for mime/size info
          break;
        }
      } catch (_) {
        // try next one
      }
    }
  }

  // Fallback to default fetch if the custom sequence didn't fetch successfully
  if (!res || !res.ok) {
    try {
      // Try with credentials for authenticated endpoints (Claude/ChatGPT private files)
      res = await fetch(url, { credentials: "include" });
    } catch(e) {
      // Fallback without credentials for external CDN images
      res = await fetch(url);
    }
  }

  // If response is not ok or was blocked by CORS, retry without credentials
  if (!res || !res.ok) {
    try {
      res = await fetch(url);
    } catch(e) {
      throw new Error("HTTP fetch failed: " + e.message);
    }
  }

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
async function fetchChatGPTFile(fileId, authHeader, conversationId) {
  // Step 1: get signed download URL + filename from download endpoint
  let url = "https://chatgpt.com/backend-api/files/" + fileId + "/download";
  if (conversationId) {
    url += "?conversation_id=" + conversationId;
  }
  const headers = { "accept": "application/json" };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }
  const dlRes = await fetch(url, {
    credentials: "include",
    headers
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
  const fileHeaders = {};
  if (downloadUrl.includes('/backend-api/') && authHeader) {
    fileHeaders["Authorization"] = authHeader;
  }
  const blobRes = await fetch(downloadUrl, { credentials: "include", headers: fileHeaders });
  if (!blobRes.ok) throw new Error("blob HTTP " + blobRes.status);
  const ct = blobRes.headers.get("content-type") || "application/octet-stream";
  const buffer = await blobRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  
  // Convert to base64 using chunking to avoid call stack size exceeded
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
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
5. If any section does not have any meaningful information in the raw transcript (e.g., no code/technical stack is mentioned, or no metrics exist yet), OMIT that section entirely. DO NOT output placeholder text (such as "None reported", "Not mentioned", "Initial stage", etc.) explaining that the information is missing.
6. **PRESERVE CONVERSATIONAL FLOW & USER CHOICE**: In the 'Task to Continue' section, if the last response in the transcript ends with a question, choice, or request for clarification to the user (e.g., "Would you like me to explain X, Y, or Z?", "Should we implement A or B?"), do NOT formulate it as a command for the AI to start generating all options unilaterally. Instead, frame 'Task to Continue' to instruct the AI to ask the user which option they would like to proceed with, allowing the conversation to resume naturally.
7. Do not include introductory or conversational filler. Output the capsule directly.`;
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
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 4096, system, messages: [{ role: "user", content: userMsg }] })
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + ": " + await res.text());
  const d = await res.json();
  return { text: d.content && d.content[0] && d.content[0].text || "" };
}

async function callGroq(apiKey, system, userMsg) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 4096, messages: [{ role: "system", content: system }, { role: "user", content: userMsg }] })
  });
  if (!res.ok) throw new Error("Groq " + res.status + ": " + await res.text());
  const d = await res.json();
  return { text: d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "" };
}

async function callGemini(apiKey, system, userMsg) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: userMsg }] }],
      generationConfig: { maxOutputTokens: 8192 },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    })
  });
  if (!res.ok) throw new Error("Gemini " + res.status + ": " + await res.text());
  const d = await res.json();
  // Handle safety-blocked or empty responses
  const candidate = d.candidates && d.candidates[0];
  if (!candidate) throw new Error("Gemini returned no candidates — content may have been blocked.");
  if (candidate.finishReason === "SAFETY") throw new Error("Gemini blocked this content due to safety filters.");
  const text = candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text || "";
  if (!text) throw new Error("Gemini returned an empty response.");
  return { text };
}

async function handleLLMTest({ provider, apiKey }) {
  if (!apiKey) throw new Error("API key is empty.");
  const user = "Hello";
  
  let res;
  if (provider === "anthropic") {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: user }] })
    });
    if (!res.ok) throw new Error("Anthropic " + res.status + ": " + await res.text());
  } else if (provider === "groq") {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 1, messages: [{ role: "user", content: user }] })
    });
    if (!res.ok) throw new Error("Groq " + res.status + ": " + await res.text());
  } else if (provider === "gemini") {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 1 }
      })
    });
    if (!res.ok) throw new Error("Gemini " + res.status + ": " + await res.text());
  } else {
    throw new Error("Unknown provider");
  }
  
  return { success: true };
}
