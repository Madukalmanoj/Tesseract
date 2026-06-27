// Tesseract — Page-context injected script
// Hooks into fetch/XHR to intercept Claude file URLs before they expire
(function () {
  if (window.__cepInjected) return;
  window.__cepInjected = true;

  // Store intercepted file URLs: { filename -> { url, contentType } }
  window.__cepFileUrls = window.__cepFileUrls || {};
  window.__cepOrgId = window.__cepOrgId || null;

  // ── Intercept fetch ─────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      // Capture org ID from any Claude API call
      const orgMatch = url.match(/\/organizations\/([a-f0-9-]{36})\//);
      if (orgMatch) window.__cepOrgId = orgMatch[1];

      // Intercept file/attachment download responses
      if (url.includes("/files/") || url.includes("/attachments/") || url.includes("file-service")) {
        const clone = res.clone();
        const ct = res.headers.get("content-type") || "";
        const cd = res.headers.get("content-disposition") || "";
        const nameMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
        const filename = nameMatch ? decodeURIComponent(nameMatch[1].trim()) : null;
        if (filename || ct.includes("pdf") || ct.includes("zip") || ct.includes("octet")) {
          clone.blob().then(blob => {
            const key = filename || url.split("/").pop() || "file";
            const reader = new FileReader();
            reader.onload = () => {
              window.__cepFileUrls[key] = { dataUrl: reader.result, mimeType: ct, url, filename: key };
              // Notify content script
              window.dispatchEvent(new CustomEvent("__cepFileCapture", { detail: { key, url, mimeType: ct, filename: key } }));
            };
            reader.readAsDataURL(blob);
          }).catch(() => {});
        }
      }
    } catch (_) {}
    return res;
  };

  // ── Intercept XHR ──────────────────────────────────────────────────────────
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cepUrl = url;
    return _XHROpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.__cepUrl || "";
        const orgMatch = url.match(/\/organizations\/([a-f0-9-]{36})\//);
        if (orgMatch) window.__cepOrgId = orgMatch[1];
        if (url.includes("/files/") || url.includes("/attachments/")) {
          const ct = this.getResponseHeader("content-type") || "";
          const cd = this.getResponseHeader("content-disposition") || "";
          const nameMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
          const filename = nameMatch ? decodeURIComponent(nameMatch[1].trim()) : url.split("/").pop() || "file";
          if (this.response && (ct.includes("pdf") || ct.includes("zip") || ct.includes("octet") || ct.includes("msword") || ct.includes("officedocument"))) {
            const blob = this.response instanceof Blob ? this.response : new Blob([this.response], { type: ct });
            const reader = new FileReader();
            reader.onload = () => {
              window.__cepFileUrls[filename] = { dataUrl: reader.result, mimeType: ct, url, filename };
              window.dispatchEvent(new CustomEvent("__cepFileCapture", { detail: { key: filename, url, mimeType: ct, filename } }));
            };
            reader.readAsDataURL(blob);
          }
        }
      } catch (_) {}
    });
    return _XHRSend.apply(this, args);
  };

  // ── Respond to content script queries ──────────────────────────────────────
  window.addEventListener("__cepQueryFiles", () => {
    window.dispatchEvent(new CustomEvent("__cepFilesResponse", {
      detail: { files: window.__cepFileUrls, orgId: window.__cepOrgId }
    }));
  });
})();
