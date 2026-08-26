(function () {
  'use strict';

  /* =========================================================
   *  Voice Catalog Buttons — повна інтеграція з онлайн-балансерами Lampa
   * ========================================================= */

  var PLUGIN          = 'voice_catalog_buttons';
  var CACHE_KEY       = 'voice_catalog_buttons_v2';
  var SUCCESS_TTL     = 6 * 60 * 60 * 1000;
  var EMPTY_TTL       = 30 * 60 * 1000;
  var CACHE_LIMIT     = 50;
  var MAX_SOURCES     = 10;
  var MAX_DEPTH       = 2;
  var REQUEST_TIMEOUT = 9000;

  function clean(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  function detectQuality(value) {
    var t = clean(value).toLowerCase();
    var q = /(?:2160p?|\b4k\b)/.test(t) ? 2160
      : /1080p?/.test(t) ? 1080
      : /720p?/.test(t) ? 720
      : /480p?/.test(t) ? 480 : 0;
    return { quality: q, hdr: /\bhdr\b/.test(t) };
  }

  function normalizeVoice(value) {
    var raw = clean(value);
    var isOrig = /\b(?:original|english|eng)\b|оригінал|оригинал|англій|англий/i.test(raw);
    var isUk   = /україн|украин|\bukr?\b|\bua\b/i.test(raw);
    var label  = clean(raw
      .replace(/(?:2160p?|\b4k\b|1080p?|720p?|480p?|\bhdr\b)/ig, '')
      .replace(/^\s*[-–—|,;:/]+|[-–—|,;:/]+\s*$/g, ''));
    return {
      label: isOrig ? 'Original' : (label || 'Без позначення'),
      language: isUk ? 'uk' : (isOrig ? 'en' : 'other')
    };
  }

  function displayLabel(g) {
    var s = g.quality === 2160 ? '4K' : (g.quality ? g.quality + 'p' : '');
    if (s && g.hdr) s += ' HDR';
    return g.label + (s ? ' — ' + s : '');
  }

  function voiceKey(c) {
    return (c.language || 'other') + ':' + clean(c.voice || c.label).toLowerCase();
  }

  function groupItems(list) {
    var map = {};
    (list || []).forEach(function (item) {
      if (!item) return;
      var voice = normalizeVoice(item.voice || item.label || item.text || item.name || item.title);
      var q = detectQuality([item.quality, item.maxquality, item.text, item.label, item.name].join(' '));
      var key = voiceKey(voice);

      if (!map[key]) {
        map[key] = {
          label: voice.label,
          language: voice.language,
          quality: 0,
          hdr: false,
          candidates: []
        };
      }
      var g = map[key];
      g.candidates.push({
        voice: voice.label,
        language: voice.language,
        quality: q.quality,
        hdr: q.hdr,
        url: item.url || item.link || item.file || '',
        balanser: item.balanser || item.source || '',
        selection: item.selection || null,
        root: !!item.root,
        raw: item
      });

      if (q.quality > g.quality) {
        g.quality = q.quality;
        g.hdr = q.hdr;
      } else if (q.quality === g.quality && q.hdr) {
        g.hdr = true;
      }
    });

    var order = { uk: 0, other: 1, en: 2 };
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) {
        var ra = order[a.language] != null ? order[a.language] : 1;
        var rb = order[b.language] != null ? order[b.language] : 1;
        if (ra !== rb) return ra - rb;
        if (b.quality !== a.quality) return b.quality - a.quality;
        if (!!b.hdr !== !!a.hdr) return b.hdr ? 1 : -1;
        return a.label.localeCompare(b.label);
      });
  }

  function getStore() {
    var s = Lampa.Storage.get(CACHE_KEY, { entries: {} });
    if (!s || typeof s !== 'object' || !s.entries) s = { entries: {} };
    return s;
  }

  function cacheGet(id) {
    try {
      var store = getStore();
      var e = store.entries[id];
      if (!e) return null;
      var ttl = e.empty ? EMPTY_TTL : SUCCESS_TTL;
      if (Date.now() - e.savedAt >= ttl) {
        delete store.entries[id];
        Lampa.Storage.set(CACHE_KEY, store);
        return null;
      }
      return JSON.parse(JSON.stringify(e.value));
    } catch (e) { return null; }
  }

  function cacheSet(id, value) {
    try {
      var store = getStore();
      store.entries[id] = {
        savedAt: Date.now(),
        empty: !value || !value.length,
        value: value
      };
      var keys = Object.keys(store.entries).sort(function (a, b) {
        return store.entries[b].savedAt - store.entries[a].savedAt;
      });
      keys.slice(CACHE_LIMIT).forEach(function (k) { delete store.entries[k]; });
      Lampa.Storage.set(CACHE_KEY, store);
    } catch (e) {}
  }

  function cacheClear(id) {
    try {
      var store = getStore();
      if (id) delete store.entries[id];
      else store.entries = {};
      Lampa.Storage.set(CACHE_KEY, store);
    } catch (e) {}
  }

  function request(url, type, timeout) {
    return new Promise(function (resolve, reject) {
      var req = new Lampa.Reguest();
      var t = setTimeout(function () {
        req.clear();
        reject(new Error('timeout'));
      }, timeout || REQUEST_TIMEOUT);

      req.quiet().timeout(timeout || REQUEST_TIMEOUT).get(url, function (data) {
        clearTimeout(t);
        try {
          if (type !== 'text' && typeof data === 'string') {
            data = JSON.parse(data);
          }
          resolve(data);
        } catch (e) { reject(e); }
      }, function (err) {
        clearTimeout(t);
        reject(err || new Error('network'));
      });
    });
  }

  function requestJson(url, timeout) {
    return request(url, 'json', timeout);
  }

  function requestText(url, timeout) {
    return request(url, 'text', timeout);
  }

  function extractRecords(html) {
    var records = [];
    if (typeof html !== 'string') return records;

    try {
      var root = document.createElement('div');
      root.innerHTML = html;

      var nodes = root.querySelectorAll('.videos__button[data-json], .videos__item[data-json], [data-json]');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        try {
          var data = JSON.parse(node.getAttribute('data-json'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

          if (data.season == null && node.getAttribute('s') != null) {
            data.season = node.getAttribute('s');
          }
          if (data.episode == null && node.getAttribute('e') != null) {
            data.episode = node.getAttribute('e');
          }

          records.push({
            kind: node.classList.contains('videos__button') ? 'button' : 'item',
            text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
            active: node.classList.contains('active') || node.classList.contains('focus') || data.active === true,
            data: data
          });
        } catch (e) {}
      }
    } catch (e) {}

    return records;
  }

  function createScanner(options) {
    options = options || {};
    var maxConcurrency = options.maxConcurrency || 3;
    var totalBudgetMs  = options.totalBudgetMs || 22000;

    function scan(params) {
      var sources   = params.sources || [];
      var season    = params.season || 0;
      var buildUrl  = params.buildProviderUrl || function (u) { return u; };
      var authUrl   = params.authorizeUrl || function (u) { return u; };
      var cacheId   = params.cacheId;

      var startTime = Date.now();
      var queue     = [];
      var active    = 0;
      var results   = [];
      var finished  = false;
      var cancelled = false;

      return new Promise(function (resolve) {
        function done() {
          if (finished) return;
          finished = true;
          var groups = groupItems(results);
          if (cacheId) cacheSet(cacheId, groups);
          resolve(groups);
        }

        function next() {
          if (cancelled || finished) return;
          if (Date.now() - startTime > totalBudgetMs) return done();
          if (!queue.length && active === 0) return done();

          while (active < maxConcurrency && queue.length) {
            var job = queue.shift();
            if (!job) break;
            active++;

            var url = authUrl(buildUrl(job.url));
            requestText(url, REQUEST_TIMEOUT)
              .then(function (html) {
                active--;
                if (cancelled || finished) return;

                var records = extractRecords(html);
                var pageItems = parseRecordsToItems(records, job);
                results = results.concat(pageItems);

                if (job.depth < MAX_DEPTH) {
                  records.forEach(function (rec) {
                    if (rec.kind === 'button' && rec.data && rec.data.url) {
                      queue.push({
                        url: rec.data.url,
                        balanser: job.balanser,
                        depth: job.depth + 1,
                        voiceHint: normalizeVoice(rec.text)
                      });
                    }
                  });
                }
                next();
              })
              .catch(function () {
                active--;
                next();
              });
          }
        }

        sources.slice(0, MAX_SOURCES).forEach(function (src) {
          var url = src.url;
          if (season > 0 && url.indexOf('season=') < 0) {
            url += (url.indexOf('?') > -1 ? '&' : '?') + 'season=' + season;
          }
          queue.push({
            url: url,
            balanser: src.balanser,
            depth: 0,
            voiceHint: null
          });
        });

        if (!queue.length) return done();
        next();

        scan.cancel = function () {
          cancelled = true;
          done();
        };
      });
    }

    return { scan: scan };
  }

  function parseRecordsToItems(records, job) {
    var items = [];
    var activeVoice = job.voiceHint;

    (records || []).forEach(function (rec) {
      if (rec.kind === 'button') {
        var v = normalizeVoice(rec.text);
        if (rec.active) activeVoice = v;
        return;
      }

      var voice = activeVoice || normalizeVoice(rec.text || (rec.data && (rec.data.translate || rec.data.voice)));
      var q = detectQuality([rec.text, rec.data && rec.data.quality, rec.data && rec.data.maxquality].join(' '));

      items.push({
        voice: voice.label,
        language: voice.language,
        quality: q.quality,
        hdr: q.hdr,
        url: (rec.data && (rec.data.url || rec.data.file)) || '',
        balanser: job.balanser,
        selection: rec.data ? {
          index: rec.data.index,
          label: rec.text,
          quality: q.quality,
          hdr: q.hdr
        } : null,
        root: job.depth === 0
      });
    });

    if (!items.length && activeVoice) {
      items.push({
        voice: activeVoice.label,
        language: activeVoice.language,
        quality: 0,
        hdr: false,
        url: job.url,
        balanser: job.balanser,
        root: true
      });
    }

    return items;
  }

  function parseJsonResponse(data, source) {
    var items = [];
    if (!data) return items;

    if (Array.isArray(data)) {
      data.forEach(function (v) {
        if (!v) return;
        items.push({
          voice: v.voice || v.translate || v.name || v.title || v.text,
          quality: v.quality || v.maxquality || v.q,
          url: v.url || v.link || v.file,
          balanser: source.balanser,
          selection: v.selection || null
        });
      });
      return items;
    }

    var list = data.voices || data.playlist || data.online || data.list || data.items || [];
    if (Array.isArray(list)) {
      list.forEach(function (v) {
        items.push({
          voice: v.voice || v.translate || v.name || v.title,
          quality: v.quality || v.maxquality,
          url: v.url || v.link || v.file,
          balanser: source.balanser,
          selection: v.selection || null
        });
      });
    }
    return items;
  }

  function showSelect(title, items, onSelect, onBack) {
    var enabled = Lampa.Controller.enabled();
    var ctrl = enabled && enabled.name ? enabled.name : enabled;
    var restored = false;

    function restore() {
      if (restored) return;
      restored = true;
      if (ctrl) Lampa.Controller.toggle(ctrl);
    }

    Lampa.Select.show({
      title: title,
      items: items,
      onBack: function () {
        restore();
        if (typeof onBack === 'function') onBack();
      },
      onSelect: function (item) {
        restore();
        if (item && (item.disabled || item.noenter)) return;
        if (typeof onSelect === 'function') onSelect(item);
      }
    });
  }

  function validateContract(json) {
    if (!json || json.voice_catalog !== true || json.contract !== 1 || !Array.isArray(json.online)) {
      throw new Error('unsupported_contract');
    }
    return json.online.filter(function (s) {
      return s && s.url && s.balanser && String(s.url).toLowerCase().indexOf('/lite/groupdeny') < 0;
    });
  }

  function buildCacheId(movie, season, sources) {
    var id = (movie && (movie.id || movie.tmdb_id || movie.imdb_id || movie.kinopoisk_id)) || 'unknown';
    var src = clean(movie && movie.source).toLowerCase();
    var key = 'vb2:' + (src ? src + ':' : '') + id + ':' + (season || 0);
    var fp = (sources || []).map(function (s) { return s.balanser + '|' + s.url; }).join(';');
    key += ':' + (fp.length > 48 ? fp.slice(0, 48) : fp);
    return key;
  }

  function openCandidate(context, candidate) {
    if (!candidate) return;

    if (typeof context.openNative === 'function') {
      var selection = {
        balanser: candidate.balanser,
        url: candidate.url
      };
      if (typeof context.buildNativeProviderUrl === 'function' && candidate.root !== false) {
        selection.url = context.buildNativeProviderUrl(candidate.url);
      }
      if (candidate.selection) {
        selection.item = candidate.selection;
      }
      context.openNative(selection);
      return;
    }

    if (candidate.url) {
      Lampa.Player.play({
        url: candidate.url,
        title: candidate.voice || 'Video'
      });
    }
  }

  function showGroups(context, groups, cacheId, season) {
    return new Promise(function (resolve) {
      var items = (groups || []).map(function (g) {
        return { title: displayLabel(g), group: g };
      });

      if (!items.length) {
        items.push({ title: 'Нічого не знайдено', disabled: true, noenter: true });
        items.push({ title: 'Повторити пошук', retry: true });
      }
      items.push({ title: 'Звичайні балансери', native: true });

      showSelect('Оберіть озвучку', items, function (item) {
        if (item.retry) {
          cacheClear(cacheId);
          runCatalog(context, season).then(resolve);
          return;
        }
        if (item.native) {
          if (typeof context.openNative === 'function') context.openNative();
          resolve();
          return;
        }
        if (item.group && item.group.candidates && item.group.candidates[0]) {
          openCandidate(context, item.group.candidates[0]);
        }
        resolve();
      }, function () {
        resolve();
      });
    });
  }

  function showSeasons(context) {
    return new Promise(function (resolve) {
      var count = parseInt(context.movie.number_of_seasons, 10) || 0;
      if (count <= 1) {
        resolve(0);
        return;
      }

      var items = [];
      for (var s = 1; s <= count; s++) {
        items.push({ title: 'Сезон ' + s, season: s });
      }

      showSelect('Оберіть сезон', items, function (item) {
        resolve(item.season || 0);
      }, function () {
        resolve(null);
      });
    });
  }

  function collectGroups(context, season) {
    var listUrl = typeof context.buildListUrl === 'function' ? context.buildListUrl() : null;
    if (!listUrl) return Promise.reject(new Error('no_list_url'));

    return requestJson(listUrl, 12000).then(function (json) {
      var sources = validateContract(json);
      if (!sources.length) throw new Error('no_sources');

      var cacheId = buildCacheId(context.movie, season, sources);
      var cached = cacheGet(cacheId);
      if (cached) {
        return { groups: cached, cacheId: cacheId, fromCache: true };
      }

      var jsonTasks = sources.slice(0, MAX_SOURCES).map(function (src) {
        var url = src.url;
        if (typeof context.buildProviderUrl === 'function') url = context.buildProviderUrl(url);
        if (typeof context.authorizeUrl === 'function') url = context.authorizeUrl(url);
        if (season > 0 && url.indexOf('season=') < 0) {
          url += (url.indexOf('?') > -1 ? '&' : '?') + 'season=' + season;
        }

        return requestJson(url, REQUEST_TIMEOUT)
          .then(function (data) { return parseJsonResponse(data, src); })
          .catch(function () { return null; });
      });

      return Promise.all(jsonTasks).then(function (results) {
        var all = [];
        var needScan = false;

        results.forEach(function (r) {
          if (r && r.length) {
            all = all.concat(r);
          } else {
            needScan = true;
          }
        });

        if (!all.length || needScan) {
          var scanner = createScanner({});
          return scanner.scan({
            sources: sources,
            movie: context.movie,
            season: season,
            buildProviderUrl: context.buildProviderUrl,
            authorizeUrl: context.authorizeUrl,
            cacheId: cacheId
          }).then(function (groups) {
            return { groups: groups, cacheId: cacheId, fromCache: false };
          });
        }

        var groups = groupItems(all);
        cacheSet(cacheId, groups);
        return { groups: groups, cacheId: cacheId, fromCache: false };
      });
    });
  }

  function runCatalog(context, season) {
    if (!context || !context.movie) {
      Lampa.Noty.show('Немає даних фільму');
      return Promise.reject(new Error('no_movie'));
    }

    if (Lampa.Loading) Lampa.Loading.start();

    var selectedSeason = season;

    return Promise.resolve()
      .then(function () {
        if (selectedSeason == null || selectedSeason === undefined) {
          return showSeasons(context).then(function (s) {
            if (s === null) throw { cancelled: true };
            selectedSeason = s || 0;
          });
        }
      })
      .then(function () {
        return collectGroups(context, selectedSeason || 0);
      })
      .then(function (result) {
        if (Lampa.Loading) Lampa.Loading.stop();
        return showGroups(context, result.groups, result.cacheId, selectedSeason || 0);
      })
      .catch(function (err) {
        if (Lampa.Loading) Lampa.Loading.stop();
        if (err && err.cancelled) return;
        console.error('[VoiceButtons]', err);
        Lampa.Noty.show('Не вдалося завантажити озвучки');
      });
  }

  var interceptEnabled = true;

  function tryIntercept(event) {
    if (!interceptEnabled) return;
    if (!Lampa.Storage.get(PLUGIN + '_enabled', true)) return;
    if (!Lampa.Storage.get(PLUGIN + '_intercept', true)) return;

    var activity = Lampa.Activity.active();
    if (!activity || !activity.component) return;

    if (event && event.type === 'button' && event.name === 'online') {
      var movie = activity.movie || activity.card || (activity.component && activity.component.movie);
      if (!movie) return;

      var context = event.context || {
        movie: movie,
        buildListUrl: function () {
          var base = Lampa.Storage.get('lampac_address') || Lampa.Storage.get('online_balance_url') || '';
          if (!base) return null;
          return base.replace(/\/$/, '') + '/lite/voice?id=' + (movie.id || movie.kinopoisk_id || '');
        },
        buildProviderUrl: function (url) { return url; },
        openNative: function () {
          Lampa.Activity.push({
            url: '',
            title: movie.title || movie.name,
            component: 'online',
            movie: movie,
            page: 1
          });
        }
      };

      if (event.voiceContext) context = event.voiceContext;

      runCatalog(context);
      return true;
    }
    return false;
  }

  var api = {
    open: runCatalog,
    group: groupItems,
    label: displayLabel,
    clearCache: function () { cacheClear(); },
    setIntercept: function (v) { interceptEnabled = !!v; },
    createContextFromMovie: function (movie, opts) {
      opts = opts || {};
      return {
        movie: movie,
        buildListUrl: opts.buildListUrl || function () {
          return opts.listUrl || null;
        },
        buildProviderUrl: opts.buildProviderUrl || function (u) { return u; },
        buildNativeProviderUrl: opts.buildNativeProviderUrl,
        authorizeUrl: opts.authorizeUrl || function (u) { return u; },
        openNative: opts.openNative || function () {
          Lampa.Activity.push({
            component: 'online',
            movie: movie,
            title: movie.title || movie.name
          });
        }
      };
    }
  };

  function start() {
    if (!window.Lampa) return;

    window.Lampa.VoiceButtons = api;
    window.VoiceButtons = api;

    if (Lampa.SettingsApi) {
      Lampa.SettingsApi.addParam({
        component: 'online',
        param: {
          name: PLUGIN + '_enabled',
          type: 'trigger',
          default: true
        },
        field: {
          name: 'Каталог озвучок',
          description: 'Показувати вибір озвучки та якості'
        }
      });

      Lampa.SettingsApi.addParam({
        component: 'online',
        param: {
          name: PLUGIN + '_intercept',
          type: 'trigger',
          default: true
        },
        field: {
          name: 'Перехоплювати кнопку «Онлайн»',
          description: 'Спочатку показувати каталог озвучок замість списку балансерів'
        }
      });
    }

    if (Lampa.Listener) {
      Lampa.Listener.follow('full', function (e) {
        if (e.type === 'button' && e.name === 'online') {
          if (tryIntercept(e)) {
            if (e.preventDefault) e.preventDefault();
          }
        }
      });
    }

    console.log('[VoiceButtons] loaded');
  }

  if (window.Lampa) start();
  else document.addEventListener('lampa:ready', start, { once: true });
})();
