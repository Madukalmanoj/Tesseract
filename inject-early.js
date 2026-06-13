// OmniExtract — Page-context hook (MAIN world, document_start)
(function() {
  if (window.__cep) return;
  window.__cep = {
    files: {},      // lcName → {dataUrl,mimeType,filename,url}
    urlMap: {},     // downloadUrl → filename (set from /download JSON)
    idMap:  {},     // fileId → filename
    orgId:  null
  };

  const IS_CLAUDE = window.location.hostname.includes('claude.ai');

  function b64(blob) {
    return new Promise((ok,fail) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = fail;
      r.readAsDataURL(blob);
    });
  }

  function save(name, dataUrl, mime, url) {
    if (!name || !dataUrl) return;
    const k = name.toLowerCase().trim();
    const e = {dataUrl, mimeType: mime||'application/octet-stream', filename: name, url};
    window.__cep.files[k] = e;
    const noext = k.replace(/\.[^.]+$/,'');
    if (noext !== k) window.__cep.files[noext] = e;
    window.dispatchEvent(new CustomEvent('__cepStored', {detail:{name,mime,url}}));
  }

  function getName(url) {
    // 1. pre-registered from /download JSON
    if (window.__cep.urlMap[url]) return window.__cep.urlMap[url];
    try {
      const u = new URL(url);
      // 2. rscd param
      const rscd = u.searchParams.get('rscd') || u.searchParams.get('response-content-disposition') || '';
      if (rscd) {
        const m = rscd.match(/filename[*]?=(?:UTF-8'')?["']?([^"';&\n\r]+)/i);
        if (m) return decodeURIComponent(m[1]).replace(/["']/g,'').trim();
      }
      // 3. path segment
      const segs = u.pathname.split('/').filter(Boolean);
      for (let i = segs.length-1; i >= 0; i--) {
        const s = decodeURIComponent(segs[i]);
        if (s.includes('.') && s !== 'download' && s.length < 200 &&
            !/^[a-f0-9\-]{20,}$/.test(s) && !/^\d+$/.test(s)) return s;
      }
    } catch(_) {}
    return null;
  }

  function mext(mime) {
    const m = (mime||'').toLowerCase();
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('zip')) return 'zip';
    if (m.includes('wordprocessingml')||m.includes('msword')) return 'docx';
    if (m.includes('spreadsheetml')) return 'xlsx';
    if (m.includes('presentationml')) return 'pptx';
    if (m.includes('text/plain')) return 'txt';
    if (m.includes('csv')) return 'csv';
    if (m.includes('png')) return 'png';
    if (m.includes('jpeg')||m.includes('jpg')) return 'jpg';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    return 'bin';
  }

  function isCapture(url, ct) {
    const u = url.toLowerCase(), c = (ct||'').toLowerCase();
    const fileUrl = u.includes('oaiusercontent') || u.includes('estuary') ||
      u.includes('/files/') || u.includes('file-service') ||
      u.includes('blob.core.windows') || u.includes('storage.googleapis') ||
      u.includes('/api/organizations/');
    const fileMime = c.includes('pdf')||c.includes('zip')||c.includes('msword')||
      c.includes('officedocument')||c.includes('octet-stream')||
      c.includes('image/png')||c.includes('image/jpeg')||
      c.includes('image/gif')||c.includes('image/webp')||
      c.includes('text/plain')||c.includes('text/csv');
    return fileUrl || fileMime;
  }

  // ── Claude Counter Bridge Constants & Helpers (Claude Only) ────────────────
  const CC_MARKER = 'ClaudeCounter';

  function cc_post(type, payload) {
    window.postMessage({ cc: CC_MARKER, type, payload }, '*');
  }

  function toAbsoluteUrl(input) {
    if (typeof input === 'string') {
      if (input.startsWith('/')) return `https://claude.ai${input}`;
      return input;
    }
    if (input instanceof URL) return input.href;
    if (input instanceof Request) return input.url;
    return '';
  }

  function getConversationMeta(url) {
    const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
    return match ? { orgId: match[1], conversationId: match[2] } : null;
  }

  async function handleConversationResponse({ orgId, conversationId }, response) {
    try {
      const cloned = response.clone();
      const data = await cloned.json();
      cc_post('cc:conversation', { orgId, conversationId, data });
    } catch {
      // ignore
    }
  }

  async function handleEventStream(response) {
    try {
      const cloned = response.clone();
      const reader = cloned.body?.getReader?.();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const json = JSON.parse(raw);
            if (json?.type === 'message_limit' && json.message_limit) {
              cc_post('cc:message_limit', json.message_limit);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Wrap history methods early to detect SPA navigation (Claude Only)
  if (IS_CLAUDE) {
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      const result = originalPushState(...args);
      window.dispatchEvent(new CustomEvent('cc:urlchange'));
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState(...args);
      window.dispatchEvent(new CustomEvent('cc:urlchange'));
      return result;
    };
  }

  // Fetch hook
  const _fetch = window.fetch;
  window.fetch = async function(...args) {
    const req = args[0];
    const opts = args[1] || {};
    const url = typeof req==='string'?req:(req instanceof Request?req.url:String(req));

    // org ID
    const om = url.match(/\/organizations\/([a-f0-9-]{36})\//);
    if (om) window.__cep.orgId = om[1];

    if (IS_CLAUDE) {
      // Claude Counter generation start detection
      const absUrl = toAbsoluteUrl(url);
      if (absUrl && opts.method === 'POST' && (absUrl.includes('/completion') || absUrl.includes('/retry_completion'))) {
        cc_post('cc:generation_start', {});
      }
    }

    const resp = await _fetch.apply(this, args);

    if (IS_CLAUDE) {
      try {
        const absUrl = toAbsoluteUrl(url);
        if (absUrl) {
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('event-stream')) {
            handleEventStream(resp);
          }

          if (absUrl.includes('/chat_conversations/') && absUrl.includes('tree=')) {
            const meta = getConversationMeta(absUrl);
            if (meta) {
              handleConversationResponse(meta, resp);
            }
          }
        }
      } catch(_) {}
    }

    try {
      // ── Intercept ChatGPT /download metadata JSON ────────────────────────
      // This gives us file_name + download_url BEFORE the blob fetch
      if (/\/backend-api\/files\/[^/?]+\/download/.test(url)) {
        resp.clone().json().then(d => {
          const fname   = d.file_name || d.fileName || d.filename || d.name || null;
          const dlUrl   = d.download_url || d.downloadUrl || d.url || null;
          if (fname && dlUrl) {
            window.__cep.urlMap[dlUrl] = fname;
            // Also without query string
            try { window.__cep.urlMap[new URL(dlUrl).origin + new URL(dlUrl).pathname] = fname; } catch(_) {}
          }
        }).catch(_=>{});
        return resp; // don't capture this JSON as a file
      }

      // ── Skip non-file responses ──────────────────────────────────────────
      const ct = resp.headers.get('content-type') || '';
      if (!isCapture(url, ct)) return resp;

      // ── Capture blob ─────────────────────────────────────────────────────
      resp.clone().blob().then(async blob => {
        if (blob.size < 100) return;
        const dataUrl = await b64(blob);
        let name = getName(url);
        if (!name) {
          const idM = url.match(/file-([a-zA-Z0-9]{8})/);
          name = idM ? ('file_'+idM[1]+'.'+mext(ct||blob.type)) : ('file.'+mext(ct||blob.type));
        }
        save(name, dataUrl, ct||blob.type, url);
      }).catch(_=>{});
    } catch(_) {}

    return resp;
  };

  // XHR hook
  const _xopen = XMLHttpRequest.prototype.open;
  const _xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u,...r) {
    this.__cepUrl = String(u||'');
    const om = this.__cepUrl.match(/\/organizations\/([a-f0-9-]{36})\//);
    if (om) window.__cep.orgId = om[1];
    return _xopen.apply(this,[m,u,...r]);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('readystatechange', function() {
      if (this.readyState!==4||this.status<200||this.status>=300) return;
      try {
        const url = this.__cepUrl||'';
        let ct=''; try{ct=this.getResponseHeader('content-type')||'';}catch(_){}
        if (!isCapture(url,ct)) return;
        let blob=null;
        if (this.response instanceof Blob) blob=this.response;
        else if (this.response instanceof ArrayBuffer) blob=new Blob([this.response],{type:ct});
        else if (typeof this.response==='string'&&this.response.length>100) blob=new Blob([this.response],{type:ct});
        if (!blob||blob.size<100) return;
        b64(blob).then(dataUrl=>{
          let name=getName(url);
          if (!name) { const idM=url.match(/file-([a-zA-Z0-9]{8})/); name=idM?('file_'+idM[1]+'.'+mext(ct||blob.type)):('file.'+mext(ct||blob.type)); }
          save(name,dataUrl,ct||blob.type,url);
        }).catch(_=>{});
      } catch(_) {}
    });
    return _xsend.apply(this,args);
  };

  // Event API
  window.addEventListener('__cepQuery', () => {
    window.dispatchEvent(new CustomEvent('__cepReply', {detail:{files:window.__cep.files, orgId:window.__cep.orgId}}));
  });
  window.addEventListener('__cepStore', e => {
    const {filename,dataUrl,mimeType,url} = e.detail||{};
    if (filename&&dataUrl) save(filename,dataUrl,mimeType,url);
  });
  window.addEventListener('__cepRegName', e => {
    const {fileId,filename} = e.detail||{};
    if (!fileId||!filename) return;
    window.__cep.idMap[fileId] = filename;
    // Re-key any blob stored under the file-id
    for (const [k,v] of Object.entries(window.__cep.files)) {
      if (k.includes(fileId.slice(0,8).toLowerCase())) save(filename,v.dataUrl,v.mimeType,v.url);
    }
  });

  // Claude Counter Message API (Claude Only)
  if (IS_CLAUDE) {
    function postResponse(requestId, ok, payload, error) {
      window.postMessage(
        {
          cc: CC_MARKER,
          type: 'cc:response',
          requestId,
          ok,
          payload,
          error
        },
        '*'
      );
    }

    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.cc !== CC_MARKER) return;
      if (data.type !== 'cc:request') return;

      const { requestId, kind, payload } = data;
      try {
        if (kind === 'hash') {
          const text = typeof payload?.text === 'string' ? payload.text : '';
          if (!text || !crypto?.subtle?.digest) {
            postResponse(requestId, false, null, 'Hash unavailable');
            return;
          }
          const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
          const bytes = new Uint8Array(buffer);
          const hash = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
          postResponse(requestId, true, { hash }, null);
          return;
        }

        if (kind === 'usage') {
          const orgId = payload?.orgId;
          if (!orgId) throw new Error('Missing orgId');
          const res = await _fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
            method: 'GET',
            credentials: 'include'
          });
          const json = await res.json();
          postResponse(requestId, true, json, null);
          return;
        }

        if (kind === 'conversation') {
          const orgId = payload?.orgId;
          const conversationId = payload?.conversationId;
          if (!orgId || !conversationId) throw new Error('Missing orgId/conversationId');

          const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
          const res = await _fetch(url, {
            method: 'GET',
            credentials: 'include'
          });
          const json = await res.json();
          cc_post('cc:conversation', { orgId, conversationId, data: json });
          postResponse(requestId, true, json, null);
          return;
        }

        throw new Error(`Unknown request kind: ${kind}`);
      } catch (e) {
        postResponse(requestId, false, null, e?.message || String(e));
      }
    });
  }
})();
