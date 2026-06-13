// OmniExtract — Page-context hook (MAIN world, document_start)
(function() {
  if (window.__cep) return;
  window.__cep = {
    files: {},      // lcName → {dataUrl,mimeType,filename,url}
    urlMap: {},     // downloadUrl → filename (set from /download JSON)
    idMap:  {},     // fileId → filename
    orgId:  null,
    authHeader: null
  };

  // Hook setRequestHeader to capture Authorization headers in XHR
  const _xsetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header && header.toLowerCase() === 'authorization') {
      window.__cep.authHeader = value;
    }
    return _xsetHeader.apply(this, [header, value]);
  };

  const IS_CLAUDE = window.location.hostname.includes('claude.ai');

  function toDataUrl(bufferOrBlob, ct) {
    return new Promise((ok, fail) => {
      try {
        let blob;
        if (bufferOrBlob instanceof Blob) {
          blob = bufferOrBlob;
        } else if (bufferOrBlob instanceof ArrayBuffer) {
          blob = new Blob([bufferOrBlob], { type: ct || 'application/octet-stream' });
        } else if (typeof bufferOrBlob === 'string') {
          const len = bufferOrBlob.length;
          const u8arr = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            u8arr[i] = bufferOrBlob.charCodeAt(i) & 0xff;
          }
          blob = new Blob([u8arr], { type: ct || 'application/octet-stream' });
        } else {
          fail(new Error('Unsupported type'));
          return;
        }

        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.onerror = () => fail(r.error);
        r.readAsDataURL(blob);
      } catch (e) {
        fail(e);
      }
    });
  }

  function save(name, dataUrl, mime, url) {
    if (!name || !dataUrl) return;
    const k = name.toLowerCase().trim();
    
    // Guard rail: prevent saving HTML/JSON response content as binary files (e.g. PDF, ZIP, DOCX, images, etc.)
    const ct = (mime || '').toLowerCase();
    const isHtmlOrJson = ct.includes('json') || ct.includes('html');
    if (isHtmlOrJson) {
      const ext = k.split('.').pop();
      const binaryExts = ['pdf', 'zip', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bin'];
      if (binaryExts.includes(ext)) {
        console.warn(`[CEP] Refusing to save HTML/JSON response as binary file: ${name} (MIME: ${mime}, URL: ${url})`);
        return;
      }
    }

    const e = {dataUrl, mimeType: mime||'application/octet-stream', filename: name, url};
    window.__cep.files[k] = e;
    const noext = k.replace(/\.[^.]+$/,'');
    if (noext !== k) window.__cep.files[noext] = e;
    
    // Debug logging
    const base64Part = dataUrl.split(',')[1] || '';
    const size = Math.round(base64Part.length * 0.75);
    console.log(`[CEP] Stored binary file: ${name} | MIME: ${mime || 'unknown'} | Size: ${size} bytes`);
    
    window.dispatchEvent(new CustomEvent('__cepStored', {detail:{name,mime,url}}));
  }

  function urlsMatchFile(url1, url2) {
    if (!url1 || !url2) return false;
    if (url1 === url2) return true;
    try {
      const u1 = new URL(url1, window.location.origin);
      const u2 = new URL(url2, window.location.origin);
      
      // 1. Compare sig parameter (unique signature query param)
      const sig1 = u1.searchParams.get('sig');
      const sig2 = u2.searchParams.get('sig');
      if (sig1 && sig2 && sig1 === sig2) return true;

      // 2. Compare file-XXXXXX ID in path
      const id1 = u1.pathname.match(/file-[a-zA-Z0-9]{8,}/);
      const id2 = u2.pathname.match(/file-[a-zA-Z0-9]{8,}/);
      if (id1 && id2 && id1[0] === id2[0]) return true;

      // 3. Fallback: compare pathname if not a generic estuary path
      if (u1.pathname === u2.pathname && !u1.pathname.includes('estuary') && !u1.pathname.includes('content')) return true;
    } catch(_) {}
    return false;
  }

  function scanJsonForFiles(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) scanJsonForFiles(obj[i]);
      return;
    }
    const id = obj.id || obj.fileId || obj.file_id || obj.file_uuid || obj.uuid || null;
    const name = obj.name || obj.filename || obj.file_name || obj.original_filename || obj.original_name || null;
    const isFileId = (typeof id === 'string') && (id.startsWith('file-') || /^[a-f0-9-]{36}$/.test(id));
    if (isFileId && typeof name === 'string' && name.includes('.')) {
      window.__cep.idMap[id] = name;
      const dlUrl = obj.download_url || obj.downloadUrl || obj.url || null;
      if (dlUrl) {
        window.__cep.urlMap[dlUrl] = name;
        try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = name; } catch(_) {}
      }
    }
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) scanJsonForFiles(obj[k]);
    }
  }

  function getName(url) {
    if (!url) return null;
    // 1. Exact match in urlMap
    if (window.__cep.urlMap[url]) return window.__cep.urlMap[url];
    try {
      const u = new URL(url, window.location.origin);
      if (window.__cep.urlMap[u.href]) return window.__cep.urlMap[u.href];
      
      // 2. Check file ID mapping from idMap
      for (const [fileId, name] of Object.entries(window.__cep.idMap)) {
        if (u.pathname.includes(fileId) || url.includes(fileId)) {
          return name;
        }
      }

      // 3. Try fuzzy signature or file ID mapping from urlMap
      for (const [dlUrl, name] of Object.entries(window.__cep.urlMap)) {
        if (urlsMatchFile(url, dlUrl)) return name;
      }

      // 4. rscd param
      const rscd = u.searchParams.get('rscd') || u.searchParams.get('response-content-disposition') || '';
      if (rscd) {
        const m = rscd.match(/filename[*]?=(?:UTF-8'')?["']?([^"';&\n\r]+)/i);
        if (m) return decodeURIComponent(m[1]).replace(/["']/g,'').trim();
      }
      
      // 5. Path segment
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
    
    // Ignore API metadata/download JSON endpoints (not actual file binaries)
    if (u.includes('/backend-api/files/file-')) return false;

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

    // Capture auth header
    let auth = null;
    if (opts.headers) {
      if (opts.headers instanceof Headers) {
        auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
      } else {
        auth = opts.headers['Authorization'] || opts.headers['authorization'];
      }
    }
    if (!auth && req instanceof Request && req.headers) {
      auth = req.headers.get('Authorization') || req.headers.get('authorization');
    }
    if (auth) {
      window.__cep.authHeader = auth;
    }

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
      const ct = resp.headers.get('content-type') || '';
      
      // 1. Intercept conversation and messages JSON payloads to map file IDs to filenames
      if (ct.includes('application/json') && (url.includes('/backend-api/') || url.includes('/api/organizations/'))) {
        resp.clone().json().then(d => {
          scanJsonForFiles(d);
        }).catch(_=>{});
      }

      // 2. Intercept ChatGPT /download metadata JSON (historical / explicit download trigger)
      if (/\/backend-api\/files\/[^/?]+\/download/.test(url)) {
        resp.clone().json().then(d => {
          const fname   = d.file_name || d.fileName || d.filename || d.name || null;
          const dlUrl   = d.download_url || d.downloadUrl || d.url || null;
          if (fname && dlUrl) {
            window.__cep.urlMap[dlUrl] = fname;
            try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = fname; } catch(_) {}
            
            // Check if we already captured a file for this download URL under a generic name
            for (const [k, v] of Object.entries(window.__cep.files)) {
              if (urlsMatchFile(v.url, dlUrl)) {
                save(fname, v.dataUrl, v.mimeType, v.url);
                delete window.__cep.files[k];
                console.log("[CEP] Late-registered and renamed generic file to:", fname);
              }
            }
          }
        }).catch(_=>{});
        return resp; // don't capture this JSON as a file
      }

      // 3. Skip non-file responses
      if (!isCapture(url, ct)) return resp;

      // 4. Capture arrayBuffer file content
      resp.clone().arrayBuffer().then(async buffer => {
        if (buffer.byteLength < 100) return;
        const dataUrl = await toDataUrl(buffer, ct);
        let name = getName(url);
        if (!name) {
          const idM = url.match(/file-([a-zA-Z0-9]{8})/);
          name = idM ? ('file_'+idM[1]+'.'+mext(ct)) : ('file.'+mext(ct));
        }
        save(name, dataUrl, ct, url);
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

        // Intercept ChatGPT /download metadata via XHR
        if (/\/backend-api\/files\/[^/?]+\/download/.test(url)) {
          try {
            const d = JSON.parse(this.responseText);
            const fname = d.file_name || d.fileName || d.filename || d.name || null;
            const dlUrl = d.download_url || d.downloadUrl || d.url || null;
            if (fname && dlUrl) {
              window.__cep.urlMap[dlUrl] = fname;
              try { window.__cep.urlMap[new URL(dlUrl, window.location.origin).href] = fname; } catch(_) {}
              
              // Late rename generic files
              for (const [k, v] of Object.entries(window.__cep.files)) {
                if (urlsMatchFile(v.url, dlUrl)) {
                  save(fname, v.dataUrl, v.mimeType, v.url);
                  delete window.__cep.files[k];
                  console.log("[CEP] XHR late-registered and renamed generic file to:", fname);
                }
              }
            }
          } catch(_) {}
          return;
        }

        // Generic XHR JSON scanner to capture file ID metadata mappings
        if (ct.includes('application/json') && (url.includes('/backend-api/') || url.includes('/api/organizations/'))) {
          try {
            const d = JSON.parse(this.responseText);
            scanJsonForFiles(d);
          } catch(_) {}
        }

        if (!isCapture(url,ct)) return;
        const respData = this.response;
        if (!respData) return;
        toDataUrl(respData, ct).then(dataUrl => {
          const base64Part = dataUrl.split(',')[1] || '';
          if (base64Part.length < 100) return;
          let name = getName(url);
          if (!name) {
            const idM = url.match(/file-([a-zA-Z0-9]{8})/);
            name = idM ? ('file_'+idM[1]+'.'+mext(ct)) : ('file.'+mext(ct));
          }
          save(name, dataUrl, ct, url);
        }).catch(_=>{});
      } catch(_) {}
    });
    return _xsend.apply(this,args);
  };

  // Event API
  window.addEventListener('__cepQuery', async () => {
    // 1. Try to fetch conversation history if authHeader is available and we are on a chatgpt conversation page
    if (window.__cep.authHeader && window.location.hostname.includes('chatgpt.com')) {
      const match = window.location.pathname.match(/\/c\/([a-f0-9-]{36})/);
      if (match) {
        const convId = match[1];
        try {
          const res = await _fetch(`/backend-api/conversation/${convId}`, {
            headers: {
              'Authorization': window.__cep.authHeader,
              'accept': 'application/json'
            }
          });
          if (res.ok) {
            const data = await res.json();
            scanJsonForFiles(data);
          }
        } catch(e) {
          console.warn("[CEP] On-demand conversation fetch failed:", e);
        }
      }
    }
    
    window.dispatchEvent(new CustomEvent('__cepReply', {
      detail: {
        files: window.__cep.files,
        orgId: window.__cep.orgId,
        authHeader: window.__cep.authHeader,
        idMap: window.__cep.idMap
      }
    }));
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
