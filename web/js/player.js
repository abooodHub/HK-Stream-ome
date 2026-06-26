var host = window.location.host;
var proto = window.location.protocol;
var wsProto = (proto === 'https:') ? 'wss:' : 'ws:';
var WEBRTC_URL = wsProto + '//' + host + '/ome-ws/app/stream';
var HLS_URL = proto + '//' + host + '/ome-hls/app/stream/master.m3u8';
var RETRY_MS = 3000;
var STALL_MS  = 9000; // reconnect if video freezes for 9s without pause

var omePlayer, retryTimer;
var _stallWatchdog  = null;
var _lastTimeUpdate = 0;
var curLevel = -1;
var isMuted = false;
var _autoplayBlocked = false;
var _tapCheckTimer = null;

function _showTapToPlay() {
  _autoplayBlocked = true;
  var el = document.getElementById('tapToPlay');
  if (el) el.style.display = 'flex';
  offline.classList.add('hidden'); // keep offline screen hidden — stream IS live
}
function _hideTapToPlay() {
  _autoplayBlocked = false;
  var el = document.getElementById('tapToPlay');
  if (el) el.style.display = 'none';
}
window.handleTapToPlay = function(e) {
  if (e) e.stopPropagation();
  _hideTapToPlay();
  if (vid) vid.play().catch(function(){});
  else if (omePlayer) omePlayer.play();
};
var isDragging = false;
var currentSource = 'unknown';

var vid = null;
var wrap = document.getElementById('ytWrap');
var offline = document.getElementById('ytOffline');
var ripple = document.getElementById('ytRipple');
var bufferEl = document.getElementById('ytBuffer');

var progEl = document.getElementById('ytProg');
var fillEl = document.getElementById('ytFill');
var bufEl = document.getElementById('ytBuf');
var thumbEl = document.getElementById('ytThumb');
var tipEl = document.getElementById('ytTip');

var volSlider = document.getElementById('ytVolSlider');
var timeEl = document.getElementById('ytTime');
var qWrap = document.getElementById('ytQWrap');
var qMenu = document.getElementById('ytQMenu');
var qLabel = document.getElementById('ytQLabel');

window.addEventListener('DOMContentLoaded', function() {
  initUIEvents();
  startPublicStatsPoller();
  initAuth();
  initPlayer();
  loadStreamTitle();
  setInterval(loadStreamTitle, 30000);
  initCountdown();

  if (document.pictureInPictureEnabled) {
    var pipBtn = document.getElementById('ytPipBtn');
    if (pipBtn) pipBtn.style.display = 'flex';
    var contextPip = document.getElementById('context-pip-item');
    if (contextPip) contextPip.style.display = 'flex';
  }
});

function _startStallWatchdog() {
  clearInterval(_stallWatchdog);
  _lastTimeUpdate = Date.now();
  _stallWatchdog = setInterval(function() {
    if (!vid || vid.paused || _autoplayBlocked) { _lastTimeUpdate = Date.now(); return; }
    if (Date.now() - _lastTimeUpdate > STALL_MS) {
      _stopStallWatchdog();
      initPlayer();
    }
  }, 2000);
}

function _stopStallWatchdog() {
  clearInterval(_stallWatchdog);
  _stallWatchdog = null;
}

function initPlayer() {
  _stopStallWatchdog();
  if (omePlayer) {
    try { omePlayer.remove(); } catch(e) {}
    omePlayer = null;
  }
  vid = null;

  omePlayer = OvenPlayer.create('ytVideo', {
    sources: [
      { type: 'webrtc', file: WEBRTC_URL, label: 'WebRTC' },
      { type: 'hls', file: HLS_URL, label: 'LL-HLS' }
    ],
    controls: false,
    showBigPlayButton: false,
    disableSeeker: true,
    autoStart: true,
    mute: false
  });

  omePlayer.on('ready', function() {
    vid = omePlayer.getMediaElement();
    if (vid) {
      initVideoEvents(vid);
      var v = parseFloat(volSlider.value) / 100;
      vid.volume = v;
      vid.muted = isMuted;
    }
    buildQualityMenu();
    setOnline(true);
    omePlayer.play();
    // Detect autoplay block: if still paused after 1.5s, show tap prompt
    clearTimeout(_tapCheckTimer);
    _tapCheckTimer = setTimeout(function() {
      if (vid && vid.paused) _showTapToPlay();
    }, 1500);
  });

  omePlayer.on('stateChanged', function(state) {
    if (state.state === 'playing') {
      clearTimeout(bufferTimeout);
      clearTimeout(_tapCheckTimer);
      _hideTapToPlay();
      bufferEl.classList.remove('show');
      setOnline(true);
      updatePlayIcons();
    } else if (state.state === 'loading') {
      clearTimeout(bufferTimeout);
      bufferTimeout = setTimeout(function() {
        if (vid && !vid.paused) bufferEl.classList.add('show');
      }, 1500);
    } else if (state.state === 'paused') {
      updatePlayIcons();
    }
  });

  omePlayer.on('sourceChanged', function(src) {
    currentSource = (src && src.type) ? src.type : 'unknown';
    var connEl = document.getElementById('stat-conn');
    if (connEl) connEl.textContent = currentSource.toUpperCase();
  });

  omePlayer.on('error', function(err) {
    if (_autoplayBlocked) return; // stream is live — just waiting for user tap
    setOnline(false);
    scheduleRetry();
  });
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(function() {
    initPlayer();
  }, RETRY_MS);
}

var offlineDelayTimer = null;
function setOnline(on) {
  var pill = document.getElementById('live-pill');
  var txt = document.getElementById('live-text');
  if (on) {
    clearTimeout(offlineDelayTimer);
    offlineDelayTimer = null;
    clearTimeout(retryTimer);
    stream_meta.online = true;
    pill.className = 'live-pill on';
    txt.textContent = 'بث مباشر';
    offline.classList.add('hidden');
    stopCountdown();
    var textEl = document.getElementById('ytOfflineText');
    if (textEl) textEl.style.display = 'none';
  } else {
    if (!offlineDelayTimer) {
      offlineDelayTimer = setTimeout(function() {
        offlineDelayTimer = null;
        stream_meta.online = false;
        pill.className = 'live-pill off';
        txt.textContent = 'غير متصل';
        if (_cdTs) startCountdown(_cdTs);
        offline.classList.remove('hidden');
        bufferEl.classList.remove('show');
      }, 5000);
    }
  }
}

var bufferTimeout = null;

function initVideoEvents(targetVid) {
  targetVid.addEventListener('playing', function() {
    clearTimeout(bufferTimeout);
    clearTimeout(_tapCheckTimer);
    _hideTapToPlay();
    bufferEl.classList.remove('show');
    setOnline(true);
    updatePlayIcons();
    _startStallWatchdog();
  });
  targetVid.addEventListener('pause', function() { _stopStallWatchdog(); updatePlayIcons(); });
  targetVid.addEventListener('ended', updatePlayIcons);
  targetVid.addEventListener('timeupdate', function() {
    _lastTimeUpdate = Date.now();
    updateProgress();
    if (!targetVid.paused) {
      clearTimeout(bufferTimeout);
      bufferEl.classList.remove('show');
    }
  });
  targetVid.addEventListener('waiting', function() {
    clearTimeout(bufferTimeout);
    bufferTimeout = setTimeout(function() {
      if (!targetVid.paused) bufferEl.classList.add('show');
    }, 1500);
  });
  targetVid.addEventListener('canplay', function() {
    clearTimeout(bufferTimeout);
    bufferEl.classList.remove('show');
  });
  targetVid.addEventListener('volumechange', updateVolIcons);
  targetVid.addEventListener('webkitbeginfullscreen', function() { updateFsIcons(true); });
  targetVid.addEventListener('webkitendfullscreen',   function() { updateFsIcons(false); });
}

function initUIEvents() {
  initTouchGestures();
  initQualityMenuEvents();

  /* النقر على منطقة الفيديو (ليس على الأزرار) يبدل التشغيل */
  wrap.addEventListener('click', function(e) {
    if (e.target.closest('.yt-ctrl') ||
        e.target.closest('#stats-nerds') ||
        e.target.closest('#player-context-menu') ||
        e.target.closest('.yt-offline') ||
        e.target.closest('#tapToPlay')) return;
    if (vid) { showRipple(vid.paused); togglePlay(); }
  });
  wrap.addEventListener('dblclick', function(e) {
    if (e.target.closest('.yt-ctrl')) return;
    toggleFullscreen();
  });

  /* توهج أعلى الفيديو عند تحريك الماوس */
  wrap.addEventListener('mousemove', function() {
    wrap.classList.add('show-ctrl');
    clearTimeout(wrap._mt);
    wrap._mt = setTimeout(function() { if (vid && !vid.paused) wrap.classList.remove('show-ctrl'); }, 2000);
  });

  /* إظهار الأدوات عند اللمس */
  wrap.addEventListener('touchstart', function() {
    wrap.classList.add('show-ctrl');
    clearTimeout(wrap._ct);
    wrap._ct = setTimeout(function() { wrap.classList.remove('show-ctrl'); }, 3500);
  }, { passive: true });

  if (progEl) {
    progEl.addEventListener('mousedown', function(e) { isDragging = true; seekAt(e); });
    progEl.addEventListener('mousemove', function(e) {
      var pct = progPct(e);
      var times = getPlayerTimes();
      if (times.isLive) {
        var hoverLag = (1 - pct) * times.range;
        tipEl.textContent = hoverLag < 2 ? 'مباشر' : '-' + fmtTime(hoverLag);
      } else {
        tipEl.textContent = fmtTime(pct * times.range);
      }
      tipEl.style.left = (pct * 100) + '%';
      if (isDragging) seekAt(e);
    });
    document.addEventListener('mousemove', function(e) { if (isDragging) seekAt(e); });
    document.addEventListener('mouseup', function() { isDragging = false; });
  }

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.yt-q-wrap')) qMenu.classList.remove('open');
    if (!e.target.closest('#player-context-menu') && !e.target.closest('.yt-wrap')) {
      document.getElementById('player-context-menu').style.display = 'none';
    }
  });

  document.addEventListener('fullscreenchange', function() {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    updateFsIcons(on);
    if (!on) _unlockOrientation();   // عاد للوضع العادي → فكّ قفل الاتجاه
  });
  document.addEventListener('webkitfullscreenchange', function() {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    updateFsIcons(on);
    if (!on) _unlockOrientation();
  });

  wrap.addEventListener('contextmenu', function(e) {
    if (!document.getElementById('auth-gate').classList.contains('hidden')) return;
    e.preventDefault();
    var rect = wrap.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    var ctxMenu = document.getElementById('player-context-menu');
    if (x + 175 > rect.width) x = rect.width - 180;
    if (y + 130 > rect.height) y = rect.height - 135;
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.style.display = 'block';
  });
}

function togglePlay() {
  if (!vid) return;
  if (vid.paused) vid.play().catch(function(){}); else vid.pause();
}
function updatePlayIcons() {
  if (!vid) return;
  document.getElementById('ytIcoPlay').style.display = vid.paused ? 'block' : 'none';
  document.getElementById('ytIcoPause').style.display = vid.paused ? 'none' : 'block';
  wrap.classList.toggle('show-ctrl', vid.paused);
}
function showRipple(willPlay) {
  var path = willPlay ? 'M8 5v14l11-7z' : 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
  ripple.querySelector('svg path').setAttribute('d', path);
  ripple.style.transform = 'translate(-50%,-50%) scale(1)';
  ripple.style.opacity = '1';
  setTimeout(function() {
    ripple.style.transform = 'translate(-50%,-50%) scale(.5)';
    ripple.style.opacity = '0';
  }, 380);
}
function getPlayerTimes() {
  if (!vid) return { start: 0, end: 0, current: 0, range: 0, isLive: false };
  var start = 0, end = 0, current = vid.currentTime;
  var duration = vid.duration;
  var isLive = !isFinite(duration);
  if (isLive) {
    if (vid.seekable && vid.seekable.length > 0) {
      start = vid.seekable.start(0);
      end = vid.seekable.end(0);
    } else {
      end = current;
    }
  } else {
    end = duration || 0;
  }
  return { start: start, end: end, current: current, range: end - start, isLive: isLive };
}

function goLive() {
  if (!vid) return;
  if (vid.seekable && vid.seekable.length > 0) {
    var seekableEnd = vid.seekable.end(0);
    var target = seekableEnd - 2.0;
    if (target < vid.seekable.start(0)) target = vid.seekable.start(0);
    vid.currentTime = target;
  }
  if (vid.paused) vid.play().catch(function(){});
  showToast('العودة للبث المباشر');
}

function updateProgress() {
  if (!progEl) return;   // شريط التقدّم محذوف (بث مباشر)
  var times = getPlayerTimes();
  if (times.range <= 0) {
    progEl.style.display = 'none';
    timeEl.textContent = 'مباشر';
    return;
  }
  progEl.style.display = '';
  var pct = (times.current - times.start) / times.range;
  pct = Math.max(0, Math.min(1, pct));
  fillEl.style.width = (pct * 100) + '%';
  thumbEl.style.left = (pct * 100) + '%';
  if (times.isLive) {
    timeEl.textContent = 'مباشر';
  } else {
    timeEl.textContent = fmtTime(times.current) + ' / ' + fmtTime(times.end);
  }
  if (vid.buffered.length) {
    var bufEnd = vid.buffered.end(vid.buffered.length - 1);
    var bufPct = (bufEnd - times.start) / times.range;
    bufEl.style.width = (Math.max(0, Math.min(1, bufPct)) * 100) + '%';
  }
}

function progPct(e) {
  var r = progEl.querySelector('.yt-prog-track').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}
function seekAt(e) {
  var times = getPlayerTimes();
  if (times.range <= 0) return;
  var pct = progPct(e);
  var target = times.start + (pct * times.range);
  vid.currentTime = target;
  fillEl.style.width = (pct * 100) + '%';
  thumbEl.style.left = (pct * 100) + '%';
}

function toggleMute() {
  isMuted = !isMuted;
  if (vid) vid.muted = isMuted;
  volSlider.value = isMuted ? 0 : (vid ? vid.volume * 100 : 100);
  updateVolIcons();
}
function setVolume(v) {
  if (vid) { vid.volume = v; vid.muted = (v === 0); }
  isMuted = (v === 0);
  updateVolIcons();
}
function updateVolIcons() {
  var v = (!vid || vid.muted || isMuted) ? 0 : vid.volume;
  document.getElementById('ytVolHigh').style.display = v > 0.5 ? 'block' : 'none';
  document.getElementById('ytVolLow').style.display  = (v > 0 && v <= 0.5) ? 'block' : 'none';
  document.getElementById('ytVolMute').style.display = v === 0 ? 'block' : 'none';
}

function buildQualityMenu() {
  var levels = [];
  if (omePlayer) {
    try { levels = omePlayer.getQualityLevels(); } catch(e) {}
  }
  if (!levels || !levels.length) { qWrap.style.display = 'none'; return; }
  qWrap.style.display = '';
  var sorted = levels.map(function(l, i) { return { l: l, i: i }; });
  sorted.sort(function(a, b) {
    var ha = a.l.height || 0, hb = b.l.height || 0;
    if (ha !== hb) return hb - ha;
    return (b.l.bitrate || 0) - (a.l.bitrate || 0);
  });
  var html = '<div class="yt-q-item active" data-idx="-1">تلقائي <span class="yt-q-badge">ABR</span></div>';
  window.levelLabelsMap = {};
  sorted.forEach(function(item) {
    var txt = item.l.label || (item.l.height ? item.l.height + 'p' : 'جودة ' + (item.i + 1));
    var h = item.l.height || 0;
    var badge = h >= 1080 ? 'FHD' : (h >= 720 ? 'HD' : (h > 0 ? 'SD' : ''));
    window.levelLabelsMap[item.i] = txt;
    html += '<div class="yt-q-item" data-idx="' + item.i + '">' + txt +
            (badge ? ' <span class="yt-q-badge">' + badge + '</span>' : '') + '</div>';
  });
  html += '<div style="border-top:1px solid rgba(255,255,255,.08);margin:4px 0;"></div>';
  html += '<div class="yt-q-item" id="menu-stats-toggle">إحصائيات تقنية</div>';
  qMenu.innerHTML = html;
}
// مستمع نقر قائمة الجودة — يُربط مرة واحدة فقط (تفويض الأحداث) لتفادي تراكمه عند إعادة الاتصال
function initQualityMenuEvents() {
  qMenu.addEventListener('click', function(e) {
    var el = e.target.closest('.yt-q-item'); if (!el) return;
    if (el.id === 'menu-stats-toggle') { toggleStatsNerds(); qMenu.classList.remove('open'); return; }
    var idx = parseInt(el.dataset.idx);
    if (omePlayer) { try { omePlayer.setCurrentQuality(idx); } catch(err) {} }
    curLevel = idx;
    qMenu.querySelectorAll('.yt-q-item').forEach(function(row) {
      row.classList.toggle('active', parseInt(row.dataset.idx) === idx);
    });
    qMenu.classList.remove('open');
    var labelText = idx === -1 ? 'تلقائي' : (window.levelLabelsMap[idx] || '—');
    qLabel.textContent = labelText;
    showToast(idx === -1 ? 'جودة تلقائية' : 'الجودة: ' + labelText);
  });
}
function toggleQMenu(e) {
  if (e) e.stopPropagation();
  qMenu.classList.toggle('open');
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function updateFsIcons(on) {
  var fsOn  = document.getElementById('ytFsOn');
  var fsOff = document.getElementById('ytFsOff');
  if (fsOn)  fsOn.style.display  = on ? 'none'  : 'block';
  if (fsOff) fsOff.style.display = on ? 'block' : 'none';
}
function toggleFakeFullscreen() {
  var on = !wrap.classList.contains('fake-fs');
  wrap.classList.toggle('fake-fs', on);
  document.body.classList.toggle('has-fake-fs', on);
  updateFsIcons(on);
  if (on) _lockLandscape(); else _unlockOrientation();
}
// قفل الشاشة أفقيًا على الجوال (Android) — iOS لا يدعم قفل الاتجاه عبر الويب
function _lockLandscape() {
  if (_isTouchDevice() && screen.orientation && screen.orientation.lock) {
    try { screen.orientation.lock('landscape').catch(function(){}); } catch(e) {}
  }
}
function _unlockOrientation() {
  if (screen.orientation && screen.orientation.unlock) {
    try { screen.orientation.unlock(); } catch(e) {}
  }
}
function toggleFullscreen() {
  if (isIOS()) {
    if (vid && vid.webkitEnterFullscreen) {
      vid.webkitEnterFullscreen();   // iOS: ملء شاشة أصلي للفيديو (يدور تلقائيًا مع الجهاز)
    } else {
      toggleFakeFullscreen();
    }
    return;
  }
  var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl) {
    var req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req) {
      var p = req.call(wrap);
      if (p && p.then) p.then(_lockLandscape).catch(function() { toggleFakeFullscreen(); });
      else _lockLandscape();
    }
    else { toggleFakeFullscreen(); }
  } else {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document); else toggleFakeFullscreen();
  }
}

function toggleWideMode() {
  if (_isInFullscreen()) return;   // لا توسيط داخل ملء الشاشة (يكسر التخطيط)
  document.body.classList.toggle('player-compact');
  var wideBtn = document.getElementById('ytWideBtn');
  var isCompact = document.body.classList.contains('player-compact');
  if (wideBtn) wideBtn.classList.toggle('active', !isCompact);
  showToast(isCompact ? 'تصغير المشغل' : 'توسيط المشغل');
  window.dispatchEvent(new Event('resize'));
}

async function togglePiP() {
  try {
    if (vid !== document.pictureInPictureElement) {
      await vid.requestPictureInPicture();
    } else {
      await document.exitPictureInPicture();
    }
  } catch(e) {
    showToast('صورة داخل صورة غير مدعومة في هذا المتصفح');
  }
}

// ═══════════════════════════════════════════════
// AUTO FULLSCREEN ON LANDSCAPE ROTATION
// ═══════════════════════════════════════════════
var _rotatedIntoFs = false;

function _isTouchDevice() {
  return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
}

function _isInFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement)
      || wrap.classList.contains('fake-fs');
}

function _handleOrientationChange() {
  if (!_isTouchDevice()) return;
  // Small delay — orientationchange fires before viewport updates
  setTimeout(function() {
    var landscape = window.innerWidth > window.innerHeight;
    var isFakeFs  = wrap.classList.contains('fake-fs');
    var isRealFs  = !!(document.fullscreenElement || document.webkitFullscreenElement);

    if (landscape && !isFakeFs && !isRealFs) {
      _rotatedIntoFs = true;
      // Use fake-fs — native fullscreen is blocked outside user gesture
      if (!wrap.classList.contains('fake-fs')) toggleFakeFullscreen();
    } else if (!landscape && _rotatedIntoFs) {
      _rotatedIntoFs = false;
      if (isFakeFs) toggleFakeFullscreen();
      else if (isRealFs) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
    }
  }, 120);
}

window.addEventListener('orientationchange', _handleOrientationChange);
if (screen.orientation) screen.orientation.addEventListener('change', _handleOrientationChange);


document.addEventListener('keydown', function(e) {
  var tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (!document.getElementById('auth-gate').classList.contains('hidden')) return;
  switch(e.key) {
    case ' ': case 'k': e.preventDefault(); if (vid) showRipple(vid.paused); togglePlay(); break;
    case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
    case 'm': case 'M': e.preventDefault(); toggleMute(); break;
    case 'l': case 'L': e.preventDefault(); goLive(); break;
    case 'p': case 'P': e.preventDefault(); togglePiP(); break;
    case 'ArrowUp':   e.preventDefault(); if(vid){setVolume(Math.min(1,vid.volume+.1));volSlider.value=vid.volume*100;showToast('الصوت: '+Math.round(vid.volume*100)+'%');} break;
    case 'ArrowDown': e.preventDefault(); if(vid){setVolume(Math.max(0,vid.volume-.1));volSlider.value=vid.volume*100;showToast('الصوت: '+Math.round(vid.volume*100)+'%');} break;
  }
});

async function initAuth() {
  try {
    var check = await fetch('/tracker-api/player-auth/check', { cache: 'no-store' }).catch(function(){ return { status: 0 }; });
    if (check.status === 403) {
      var checkData = await check.json().catch(function(){ return {}; });
      if (checkData.error === 'banned') { window.location.href = '/kicked.html'; return; }
      if (checkData.error === 'kicked') { window.location.href = '/kicked.html'; return; }
    }
    var r = await fetch('/tracker-api/player-auth/status', { cache: 'no-store' });
    var d = await r.json();
    if (!d.enabled) return;
    var test = await fetch(HLS_URL, { method: 'HEAD', credentials: 'include', cache: 'no-store' }).catch(function(){ return { status: 0 }; });
    if (test.status !== 403) return;
    showGate();
  } catch(e) {}
}
function showGate() {
  document.getElementById('auth-gate').classList.remove('hidden');
  setTimeout(function() { document.getElementById('gate-pass').focus(); }, 100);
}
function hideGate() { document.getElementById('auth-gate').classList.add('hidden'); }

var gateLockTimer = null;   // يعمل أثناء الإيقاف المؤقت

function shakeGate() {
  var box = document.querySelector('.gate-box');
  if (box) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); setTimeout(function() { box.classList.remove('shake'); }, 500); }
}

function startGateLock(errEl, btn, seconds) {
  var input = document.getElementById('gate-pass');
  if (input) { input.disabled = true; input.value = ''; }
  btn.disabled = true;
  shakeGate();
  var remain = seconds;
  function fmt(s) { var m = Math.floor(s/60), ss = s%60; return m + ':' + (ss<10?'0':'') + ss; }
  function tick() {
    if (remain <= 0) {
      clearInterval(gateLockTimer); gateLockTimer = null;
      if (input) { input.disabled = false; input.focus(); }
      btn.disabled = false; btn.textContent = 'دخول';
      errEl.textContent = '';
      return;
    }
    btn.textContent = '🔒 ' + fmt(remain);
    errEl.textContent = 'محاولات كثيرة — حاول مجدداً بعد ' + fmt(remain);
    remain--;
  }
  tick();
  gateLockTimer = setInterval(tick, 1000);
}

async function submitGatePassword() {
  if (gateLockTimer) return;   // مقفل حالياً — تجاهل
  var pw = document.getElementById('gate-pass').value;
  var errEl = document.getElementById('gate-error');
  var btn = document.getElementById('gate-btn');
  if (!pw) return;
  errEl.textContent = ''; btn.disabled = true; btn.textContent = '…';
  try {
    var r = await fetch('/tracker-api/player-auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ password: pw })
    });
    var d = await r.json();
    if (d.ok && d.token) {
      hideGate(); initPlayer(); return;
    }
    if (r.status === 429) {                       // إيقاف مؤقت — عدّاد تنازلي
      startGateLock(errEl, btn, d.retry_after || 300);
      return;
    }
    // كلمة مرور خاطئة (401)
    document.getElementById('gate-pass').value = '';
    document.getElementById('gate-pass').focus();
    errEl.textContent = (d.error || 'كلمة المرور غير صحيحة') +
      (d.remaining != null ? ' — تبقّى ' + d.remaining + ' محاولة' : '');
    shakeGate();
    btn.disabled = false; btn.textContent = 'دخول';
  } catch(e) {
    errEl.textContent = 'خطأ في الاتصال';
    btn.disabled = false; btn.textContent = 'دخول';
  }
}

var statsEvtSource = null;
function startPublicStatsPoller() {
  pollStreamOnline();
  setInterval(pollStreamOnline, 8000);
  if (typeof EventSource !== 'undefined') {
    connectSSE();
  } else {
    pollStatsFallback();
    setInterval(pollStatsFallback, 5000);
  }
  sendHeartbeat();
  setInterval(sendHeartbeat, 5000);
}

function connectSSE() {
  if (statsEvtSource) statsEvtSource.close();
  statsEvtSource = new EventSource('/tracker-api/public/stats/live');
  statsEvtSource.onmessage = function(e) {
    try {
      var d = JSON.parse(e.data);
      if (d.action === 'kicked') { window.location.href = '/kicked.html'; return; }
      if (d.action === 'banned') { window.location.href = '/kicked.html'; return; }
      if (d.action === 'auth_changed') {
        if (d.enabled) { initAuth(); }            // تفعيل الحماية → يظهر القفل فوراً لمن لا يملك توكن
        else { hideGate(); initPlayer(); }        // إلغاء الحماية → يُخفى القفل ويبدأ البث
        return;
      }
      updateStatsUI(d.viewers, d.online);
    } catch(err) {}
  };
  statsEvtSource.onerror = function() {
    statsEvtSource.close();
    fetch('/tracker-api/player-auth/check', { cache: 'no-store' })
      .then(function(r) {
        if (r.status === 403) {
          return r.json().then(function(d) {
            if (d.error === 'kicked') { window.location.href = '/kicked.html'; }
            else if (d.error === 'banned') { window.location.href = '/kicked.html'; }
            else { setTimeout(connectSSE, 5000); }
          });
        } else {
          setTimeout(connectSSE, 5000);
        }
      })
      .catch(function() { setTimeout(connectSSE, 5000); });
  };
}

function pollStreamOnline() {
  fetch(HLS_URL, { cache: 'no-store', method: 'HEAD' })
    .then(function(r) {
      if (r.status === 403) {
        if (omePlayer) { try { omePlayer.remove(); } catch(e) {} omePlayer = null; }
        showGate();
      } else if (r.ok) {
        if (!omePlayer) initPlayer();
      }
    })
    .catch(function() {});
}

function pollStatsFallback() {
  fetch('/tracker-api/public/stats', { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(d) { updateStatsUI(d.viewers, d.online); })
    .catch(function(){});
}

function loadStreamTitle() {
  fetch('/tracker-api/stream/title', { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.title) {
        document.title = d.title + ' — بث مباشر';
      }
    })
    .catch(function(){});
}

function updateStatsUI(viewers, online) {
  var v = viewers || 0;
  var hv = document.getElementById('headViewersNum');
  if (hv && hv.textContent !== String(v)) animateNumberChange(hv, v);
  if (online !== undefined && !online) {
    if (!vid || vid.paused) setOnline(false);
  }
}

function animateNumberChange(el, targetVal) {
  el.style.transform = 'scale(0.8)'; el.style.opacity = '0';
  setTimeout(function() {
    el.textContent = targetVal; el.style.transform = 'scale(1)'; el.style.opacity = '1';
  }, 150);
}

function detectBrowser() {
  var ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung';   // قبل Chrome — UA سامسونج يحوي Chrome أيضاً
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}
function currentQualityLabel() {
  if (!omePlayer) return 'تلقائي';
  try {
    var qualities = omePlayer.getQualityLevels();
    var currentIdx = omePlayer.getCurrentQuality();
    if (qualities && qualities.length > 0 && currentIdx !== undefined) {
      var q = qualities[currentIdx];
      var labelText = q ? (q.label || q.height + 'p') : 'تلقائي';
      return curLevel === -1 ? 'تلقائي (' + labelText + ')' : labelText;
    }
  } catch(e) {}
  return 'تلقائي';
}
function sendHeartbeat() {
  fetch('/tracker-api/heartbeat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ quality: currentQualityLabel(), browser: detectBrowser() })
  })
  .then(function(r) {
    if (r.status === 403) {
      return r.json().then(function(d) {
        if (d.error === 'banned') { window.location.href = '/kicked.html'; }
        else if (d.error === 'kicked') { window.location.href = '/kicked.html'; }
      });
    }
  })
  .catch(function(){});
}

function toggleGateEye() {
  var input = document.getElementById('gate-pass');
  var eyeEl = document.getElementById('gate-eye');
  if (!input) return;
  input.type = (input.type === 'password') ? 'text' : 'password';
  if (eyeEl) eyeEl.classList.toggle('open', input.type === 'text');
}

var statsInterval = null;
function toggleStatsNerds() {
  var statsCard = document.getElementById('stats-nerds');
  statsCard.classList.toggle('show');
  var isShow = statsCard.classList.contains('show');
  document.getElementById('player-context-menu').style.display = 'none';
  var toggleEl = document.getElementById('menu-stats-toggle');
  if (toggleEl) toggleEl.classList.toggle('active', isShow);
  if (isShow) {
    startStatsPoller();
  } else {
    clearInterval(statsInterval);
  }
}
function startStatsPoller() {
  clearInterval(statsInterval);
  updateStatsNerds();
  statsInterval = setInterval(updateStatsNerds, 1000);
}
function updateStatsNerds() {
  if (!vid) return;
  var times = getPlayerTimes();
  var resEl = document.getElementById('stat-res');
  var bufEl2 = document.getElementById('stat-buf');
  var latEl = document.getElementById('stat-lat');
  var droppedEl = document.getElementById('stat-dropped');
  if (resEl) resEl.textContent = vid.videoWidth && vid.videoHeight ? (vid.videoWidth + 'x' + vid.videoHeight) : '—';
  if (bufEl2) {
    var health = 0;
    for (var i = 0; i < vid.buffered.length; i++) {
      if (vid.currentTime >= vid.buffered.start(i) && vid.currentTime <= vid.buffered.end(i)) {
        health = vid.buffered.end(i) - vid.currentTime; break;
      }
    }
    bufEl2.textContent = health.toFixed(1) + 's';
  }
  if (latEl) {
    var lag = times.end - times.current;
    latEl.textContent = times.isLive ? (lag >= 0 ? lag.toFixed(1) + 's' : '0.0s') : 'VOD';
  }
  if (droppedEl) {
    var dropped = vid.getVideoPlaybackQuality ? vid.getVideoPlaybackQuality().droppedVideoFrames : 0;
    droppedEl.textContent = dropped;
  }
}

/* ── COUNTDOWN ── */
var _cdInterval = null;
var _cdTs = null;

function initCountdown() {
  fetch('/tracker-api/next-match', { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ts) startCountdown(d.ts);
    })
    .catch(function() {});
  setInterval(function() {
    fetch('/tracker-api/next-match', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ts !== _cdTs) {
          _cdTs = d.ts;
          if (d.ts) startCountdown(d.ts); else stopCountdown();
        }
      }).catch(function() {});
  }, 60000);
}

function startCountdown(ts) {
  _cdTs = ts;
  if (_cdInterval) clearInterval(_cdInterval);
  function tick() {
    var now = Math.floor(Date.now() / 1000);
    var diff = ts - now;
    var bar = document.getElementById('countdown-bar');
    var isOnline = stream_meta && stream_meta.online;
    if (!bar || diff <= 0 || isOnline) { stopCountdown(); return; }
    bar.classList.remove('hidden');
    var d = Math.floor(diff / 86400);
    var h = Math.floor((diff % 86400) / 3600);
    var m = Math.floor((diff % 3600) / 60);
    var s = diff % 60;
    function z(n) { return n < 10 ? '0' + n : '' + n; }
    document.getElementById('cd-d').textContent = z(d);
    document.getElementById('cd-h').textContent = z(h);
    document.getElementById('cd-m').textContent = z(m);
    document.getElementById('cd-s').textContent = z(s);
  }
  tick();
  _cdInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (_cdInterval) { clearInterval(_cdInterval); _cdInterval = null; }
  var bar = document.getElementById('countdown-bar');
  if (bar) bar.classList.add('hidden');
}

var stream_meta = { online: false };

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
}
function pad(n) { return n < 10 ? '0' + n : '' + n; }

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function() { t.classList.remove('show'); }, 2200);
}

function initTouchGestures() {
  var brightnessOverlay = document.getElementById('brightness-overlay');
  var touchStartX = 0, touchStartY = 0;
  var isSwiping = false, swipeDirection = null, activeSide = null, initialVal = 0, lastTapTime = 0;

  wrap.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    var touch = e.touches[0];
    touchStartX = touch.clientX; touchStartY = touch.clientY;
    isSwiping = false; swipeDirection = null;
    var rect = wrap.getBoundingClientRect();
    var touchXRel = touchStartX - rect.left;
    if (touchXRel < rect.width / 2) {
      activeSide = 'left';
      var op = parseFloat(brightnessOverlay.style.opacity) || 0;
      initialVal = 1 - op;
    } else {
      activeSide = 'right';
      initialVal = vid ? vid.volume : 1;
    }
    var now = Date.now();
    var tapDelay = now - lastTapTime;
    if (tapDelay < 300 && tapDelay > 0) { e.preventDefault(); goLive(); lastTapTime = 0; return; }
    lastTapTime = now;
  }, { passive: false });

  wrap.addEventListener('touchmove', function(e) {
    if (e.touches.length !== 1) return;
    var touch = e.touches[0];
    var diffX = touch.clientX - touchStartX;
    var diffY = touch.clientY - touchStartY;
    if (!isSwiping) {
      if (Math.abs(diffY) > 10 && Math.abs(diffY) > Math.abs(diffX)) { isSwiping = true; swipeDirection = 'vertical'; }
      else if (Math.abs(diffX) > 10) { isSwiping = true; swipeDirection = 'horizontal'; }
    }
    if (isSwiping && swipeDirection === 'vertical') {
      e.preventDefault();
      var rect = wrap.getBoundingClientRect();
      var delta = -diffY / (rect.height || 200);
      var newVal = Math.max(0, Math.min(1, initialVal + delta));
      if (activeSide === 'left') {
        brightnessOverlay.style.opacity = (1 - newVal).toFixed(2);
        showToast('السطوع: ' + Math.round(newVal * 100) + '%');
      } else {
        setVolume(newVal); volSlider.value = newVal * 100;
        showToast('الصوت: ' + Math.round(newVal * 100) + '%');
      }
    }
  }, { passive: false });

  wrap.addEventListener('touchend', function(e) {
    if (isSwiping) e.preventDefault();
  }, { passive: false });
}
