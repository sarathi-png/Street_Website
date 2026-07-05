document.addEventListener('DOMContentLoaded', function () {
  initTheme();
  initLightbox();
  initModals();
  initToast();
  initDriveImport();
  initLikeShare();
  initSlideshow();
  initBulkSelect();
  initUploadProgress();
});

function initTheme() {
  var toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  var saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  toggle.textContent = saved === 'dark' ? '☀️' : '🌙';
  toggle.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    toggle.textContent = next === 'dark' ? '☀️' : '🌙';
  });
}

function initLightbox() {
  var lb = document.getElementById('lightbox');
  var content = document.getElementById('lightboxContent');
  var caption = document.getElementById('lightboxCaption');
  var counter = document.getElementById('lightboxCounter');
  var closeBtn = document.getElementById('lightboxClose');
  var prevBtn = document.getElementById('lightboxPrev');
  var nextBtn = document.getElementById('lightboxNext');
  if (!lb) return;

  var currentId = null;
  var cards = [];

  function refreshCards() {
    cards = Array.from(document.querySelectorAll('.media-card'));
  }

  function open(id) {
    refreshCards();
    var card = document.querySelector('.media-card[data-id="' + id + '"]');
    var src = card ? card.getAttribute('data-src') : '/uploads/' + (document.querySelector('#lightboxTrigger')?.getAttribute('data-filename') || '');
    var title = card?.querySelector('.media-card-title')?.textContent || document.querySelector('.media-view-title')?.textContent || '';
    var type = card?.getAttribute('data-type') || 'photo';
    var idx = cards.findIndex(function (el) { return parseInt(el.getAttribute('data-id')) === parseInt(id); });

    if (type === 'video') {
      content.innerHTML = '<video controls preload="metadata" class="media-view-video" style="max-height:85vh;border-radius:8px"><source src="' + src + '"></video>';
    } else {
      content.innerHTML = '<img src="' + src + '" alt="' + title + '">';
    }
    caption.textContent = title;
    counter.textContent = idx >= 0 ? (idx + 1) + ' / ' + cards.length : '';
    currentId = id;
    lb.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    lb.classList.add('hidden');
    content.innerHTML = '';
    caption.textContent = '';
    counter.textContent = '';
    currentId = null;
    document.body.style.overflow = '';
  }

  function navigate(dir) {
    if (!currentId) return;
    refreshCards();
    var idx = cards.findIndex(function (el) { return parseInt(el.getAttribute('data-id')) === parseInt(currentId); });
    if (idx === -1) return close();
    var nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= cards.length) return;
    open(cards[nextIdx].getAttribute('data-id'));
  }

  document.querySelectorAll('.media-card').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (e.target.closest('.media-card-overlay, .btn')) return;
      e.preventDefault();
      open(el.getAttribute('data-id'));
    });
  });

  var trigger = document.getElementById('lightboxTrigger');
  if (trigger) trigger.addEventListener('click', function () { open(trigger.getAttribute('data-id')); });

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (prevBtn) prevBtn.addEventListener('click', function () { navigate(-1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { navigate(1); });

  document.addEventListener('keydown', function (e) {
    if (lb.classList.contains('hidden')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  });
  lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
}

function initModals() {
  var overlay;

  function bindEdit(selector, fieldMap, formId, actionPrefix, closeId, overlayId) {
    document.querySelectorAll(selector).forEach(function (btn) {
      btn.addEventListener('click', function () {
        Object.keys(fieldMap).forEach(function (fid) {
          var el = document.getElementById(fid);
          if (el) el.value = fieldMap[fid](btn);
        });
        var form = document.getElementById(formId);
        if (form) form.action = actionPrefix + btn.getAttribute('data-' + (Object.keys(fieldMap)[0].includes('edit_') ? 'id' : 'cat-id') || btn.getAttribute('data-id'));
        var modal = document.getElementById(closeId.replace('Cancel', 'Modal'));
        if (modal) modal.classList.remove('hidden');
      });
    });
    document.getElementById(closeId)?.addEventListener('click', function () { document.getElementById(closeId.replace('Cancel', 'Modal'))?.classList.add('hidden'); });
    overlay = document.getElementById(overlayId);
    if (overlay) overlay.addEventListener('click', function () { document.getElementById(overlayId.replace('Overlay', 'Modal'))?.classList.add('hidden'); });
  }

  bindEdit('.btn-edit[data-id]', {
    'edit_title': function(b) { return b.getAttribute('data-title'); },
    'edit_category_id': function(b) { return b.getAttribute('data-category'); },
    'edit_description': function(b) { return b.getAttribute('data-description') || ''; },
    'edit_tags': function(b) { return b.getAttribute('data-tags') || ''; }
  }, 'editForm', '/admin/media/edit/', 'modalCancel', 'modalOverlay');

  bindEdit('.btn-edit[data-cat-id]', {
    'cat_edit_name': function(b) { return b.getAttribute('data-cat-name'); },
    'cat_edit_desc': function(b) { return b.getAttribute('data-cat-desc'); }
  }, 'catEditForm', '/admin/categories/edit/', 'catModalCancel', 'catModalOverlay');

  document.querySelectorAll('.btn-edit[data-user-id]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.getElementById('pwUserName').textContent = btn.getAttribute('data-user-name');
      document.getElementById('passwordForm').action = '/admin/users/reset-password/' + btn.getAttribute('data-user-id');
      document.getElementById('passwordModal').classList.remove('hidden');
    });
  });
  document.getElementById('pwModalCancel')?.addEventListener('click', function () { document.getElementById('passwordModal').classList.add('hidden'); });
  document.getElementById('pwModalOverlay')?.addEventListener('click', function () { document.getElementById('passwordModal').classList.add('hidden'); });
}

function initToast() {
  var params = new URLSearchParams(window.location.search);
  var msg = params.get('msg');
  if (msg) {
    var toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.innerHTML = '<i class="fas fa-check-circle"></i> ' + decodeURIComponent(msg);
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5000);
  }
}

function initDriveImport() {
  var form = document.getElementById('driveImportForm');
  if (!form) return;
  var btn = document.getElementById('driveImportBtn');
  var progress = document.getElementById('driveProgress');
  var label = document.getElementById('driveProgressLabel');
  var count = document.getElementById('driveProgressCount');
  var bar = document.getElementById('driveProgressBar');
  var errDiv = document.getElementById('driveProgressError');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(form);
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Listing...';
    progress.classList.add('hidden');

    fetch(form.action, { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)), headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { showToast(data.error, 'error'); btn.disabled = false; btn.innerHTML = '<i class="fab fa-google-drive"></i> Import from Drive'; return; }
        if (!data.jobId) { showToast('Imported successfully', 'success'); btn.disabled = false; btn.innerHTML = '<i class="fab fa-google-drive"></i> Import from Drive'; location.reload(); return; }
        progress.classList.remove('hidden');
        label.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Importing files...';
        count.textContent = '0 / 0';
        bar.style.width = '0%';
        errDiv.textContent = '';

        var evtSource = new EventSource('/admin/import-progress/' + data.jobId);
        evtSource.onmessage = function (ev) {
          var d = JSON.parse(ev.data);
          count.textContent = d.current + ' / ' + d.total;
          bar.style.width = Math.round((d.current / d.total) * 100) + '%';
          if (d.lastError) { errDiv.textContent = d.errors + ' failed — ' + d.lastError; }
          else if (d.errors > 0) { errDiv.textContent = d.errors + ' failed'; }
        };
        evtSource.addEventListener('done', function (ev) {
          var d = JSON.parse(ev.data);
          label.innerHTML = '<i class="fas fa-check-circle" style="color:var(--clr-success)"></i> ' + d.message;
          evtSource.close();
          btn.disabled = false;
          btn.innerHTML = '<i class="fab fa-google-drive"></i> Import from Drive';
          setTimeout(function () { location.href = '/admin/media'; }, 2000);
        });
        evtSource.addEventListener('error', function () {
          label.innerHTML = '<i class="fas fa-exclamation-circle" style="color:var(--clr-danger)"></i> Import connection lost — check server logs';
          evtSource.close();
          btn.disabled = false;
          btn.innerHTML = '<i class="fab fa-google-drive"></i> Import from Drive';
        });
      })
      .catch(function (err) {
        showToast('Import failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fab fa-google-drive"></i> Import from Drive';
      });
  });
}

function showToast(msg, type) {
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + (type || 'success');
  toast.innerHTML = '<i class="fas fa-' + (type === 'error' ? 'exclamation-circle' : 'check-circle') + '"></i> ' + msg;
  document.body.appendChild(toast);
  setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 5000);
}

function initLikeShare() {
  var likeBtn = document.getElementById('likeBtn');
  var shareBtn = document.getElementById('shareBtn');
  var favBtn = document.getElementById('favBtn');

  if (likeBtn) {
    likeBtn.addEventListener('click', function () {
      fetch('/like/' + likeBtn.getAttribute('data-id'), { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var txt = document.getElementById('likeBtnText');
          var num = document.getElementById('likeCountNum');
          if (d.liked) {
            likeBtn.className = 'btn btn-sm btn-primary';
            txt.textContent = 'Liked';
            num.textContent = parseInt(num.textContent) + 1;
            showToast('Liked', 'success');
          } else {
            likeBtn.className = 'btn btn-sm btn-secondary';
            txt.textContent = 'Like';
            num.textContent = parseInt(num.textContent) - 1;
            showToast('Unliked', 'success');
          }
        });
    });
  }
  if (shareBtn) {
    shareBtn.addEventListener('click', function () {
      fetch('/share/' + shareBtn.getAttribute('data-id'), { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.url) {
            var full = window.location.origin + d.url;
            if (navigator.clipboard) { navigator.clipboard.writeText(full).then(function () { showToast('Share link copied!', 'success'); }); }
            else { prompt('Copy this link:', full); }
          } else { showToast('Failed to create share link', 'error'); }
        });
    });
  }

  if (favBtn) {
    favBtn.addEventListener('click', function () {
      fetch('/favorite/' + favBtn.getAttribute('data-id'), { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var txt = document.getElementById('favBtnText');
          if (d.favorited) {
            favBtn.className = 'btn btn-sm btn-primary';
            txt.textContent = 'Favorited';
            showToast('Added to favorites', 'success');
          } else {
            favBtn.className = 'btn btn-sm btn-secondary';
            txt.textContent = 'Favorite';
            showToast('Removed from favorites', 'success');
          }
        });
    });
  }
}

function initBulkSelect() {
  var selectAll = document.getElementById('selectAll');
  if (!selectAll) return;
  var checks = document.querySelectorAll('.bulk-check');
  var bulkForm = document.getElementById('bulkForm');
  var bulkCount = document.getElementById('bulkCount');
  var bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
  var bulkClearBtn = document.getElementById('bulkClearBtn');
  var bulkCategorySelect = document.getElementById('bulkCategorySelect');

  function update() {
    var selected = Array.from(checks).filter(function (c) { return c.checked; });
    if (selected.length) {
      bulkForm.style.display = 'flex';
      bulkCount.textContent = selected.length + ' selected';
    } else {
      bulkForm.style.display = 'none';
    }
  }

  selectAll.addEventListener('change', function () {
    checks.forEach(function (c) { c.checked = selectAll.checked; });
    update();
  });

  checks.forEach(function (c) {
    c.addEventListener('change', function () {
      selectAll.checked = checks.length === Array.from(checks).filter(function (x) { return x.checked; }).length;
      update();
    });
  });

  function getIds() { return Array.from(checks).filter(function (c) { return c.checked; }).map(function (c) { return c.value; }).join(','); }

  bulkClearBtn.addEventListener('click', function () {
    checks.forEach(function (c) { c.checked = false; });
    selectAll.checked = false;
    update();
  });

  bulkDeleteBtn.addEventListener('click', function () {
    var ids = getIds();
    if (!ids) return;
    if (confirm('Delete ' + ids.split(',').length + ' media items permanently?')) {
      var form = document.createElement('form');
      form.method = 'POST';
      form.action = '/admin/media/bulk-delete';
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'ids';
      input.value = ids;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    }
  });

  bulkCategorySelect.addEventListener('change', function () {
    var ids = getIds();
    if (!ids || !bulkCategorySelect.value) return;
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = '/admin/media/bulk-move';
    ['ids', 'category_id'].forEach(function (n) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = n;
      input.value = n === 'ids' ? ids : bulkCategorySelect.value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  });
}

function initSlideshow() {
  var btn = document.getElementById('slideshowBtn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var cards = document.querySelectorAll('.media-card');
    var photos = Array.from(cards).filter(function (el) { return el.getAttribute('data-type') === 'photo'; });
    if (photos.length === 0) { showToast('No photos to show', 'error'); return; }
    var idx = 0;
    var overlay = document.createElement('div');
    overlay.className = 'slideshow-overlay';
    overlay.innerHTML = '<div class="slideshow-container"><img class="slideshow-img" src="" alt=""><div class="slideshow-counter"></div><button class="slideshow-close">&times;</button><button class="slideshow-prev">&lsaquo;</button><button class="slideshow-next">&rsaquo;</button><div class="slideshow-speed"><label><input type="range" min="1" max="10" value="4" class="slideshow-range"> <span class="slideshow-speed-label">4s</span></label></div></div>';
    document.body.appendChild(overlay);

    var img = overlay.querySelector('.slideshow-img');
    var counter = overlay.querySelector('.slideshow-counter');
    var closeBtn = overlay.querySelector('.slideshow-close');
    var prevBtn = overlay.querySelector('.slideshow-prev');
    var nextBtn = overlay.querySelector('.slideshow-next');
    var range = overlay.querySelector('.slideshow-range');
    var speedLabel = overlay.querySelector('.slideshow-speed-label');
    var timer;

    function show() {
      var el = photos[idx];
      var src = el.getAttribute('data-src');
      img.src = src.startsWith('/stream/') ? ('/media/' + el.getAttribute('data-id')) : src;
      counter.textContent = (idx + 1) + ' / ' + photos.length;
    }

    function startTimer() { clearInterval(timer); timer = setInterval(function () { idx = (idx + 1) % photos.length; show(); }, parseInt(range.value) * 1000); }

    show();
    startTimer();

    closeBtn.addEventListener('click', function () { clearInterval(timer); document.body.removeChild(overlay); document.body.style.overflow = ''; });
    prevBtn.addEventListener('click', function () { clearInterval(timer); idx = (idx - 1 + photos.length) % photos.length; show(); startTimer(); });
    nextBtn.addEventListener('click', function () { clearInterval(timer); idx = (idx + 1) % photos.length; show(); startTimer(); });
    range.addEventListener('input', function () { speedLabel.textContent = range.value + 's'; clearInterval(timer); startTimer(); });
    document.addEventListener('keydown', function ssKey(e) {
      if (!document.body.contains(overlay)) { document.removeEventListener('keydown', ssKey); return; }
      if (e.key === 'Escape') closeBtn.click();
      if (e.key === 'ArrowLeft') prevBtn.click();
      if (e.key === 'ArrowRight') nextBtn.click();
    });
    document.body.style.overflow = 'hidden';
  });
}

function initUploadProgress() {
  var form = document.getElementById('uploadForm');
  if (!form) return;
  var btn = document.getElementById('uploadBtn');
  var progress = document.getElementById('uploadProgress');
  var bar = document.getElementById('uploadProgressBar');
  var text = document.getElementById('uploadProgressText');

  form.addEventListener('submit', function (e) {
    var fileInput = document.getElementById('file');
    if (!fileInput.files.length) return;
    e.preventDefault();
    var fd = new FormData(form);
    var xhr = new XMLHttpRequest();
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
    progress.classList.remove('hidden');
    bar.style.width = '0%';
    text.textContent = '0%';

    xhr.upload.addEventListener('progress', function (ev) {
      if (ev.lengthComputable) {
        var pct = Math.round((ev.loaded / ev.total) * 100);
        bar.style.width = pct + '%';
        text.textContent = pct + '%';
      }
    });
    xhr.addEventListener('load', function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        window.location.href = '/admin/media?msg=Uploaded+successfully';
      } else {
        showToast('Upload failed', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Upload';
        progress.classList.add('hidden');
      }
    });
    xhr.addEventListener('error', function () {
      showToast('Upload failed', 'error');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Upload';
      progress.classList.add('hidden');
    });
    xhr.open('POST', form.action);
    xhr.send(fd);
  });
}
