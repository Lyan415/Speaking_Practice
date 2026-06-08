(function () {
  'use strict';

  // ===== CONFIG =====
  const CONFIG = {
    GAS_URL: 'https://script.google.com/macros/s/AKfycbzbjR-EHGFVYZ80Y6LHGVzfsLQiXPk9QB5nzuXERGCDMRcuXWQ7CEo2uzOjODCym_BM/exec',
    SESSION_KEY: 'speaking_practice_session',
    SETTINGS_KEY: 'speaking_practice_settings',
    DATA_KEY: 'speaking_practice_data',
    SYNC_TIME_KEY: 'speaking_practice_last_sync',
    SEQUENCE_LENGTH: 8,
    PASSWORD_SALT: '_speaking_practice_salt_2026',
    CRYPTO_SALT: 'speaking_practice_crypto_v1',
    INTERVALS: [0, 1, 2, 4, 7, 15, 30],
    MAX_LEVEL: 6,
    DAILY_MAX: 25,
    PLAN_VERSION: 1
  };

  // ===== STATE =====
  let currentSequence = [];
  let currentUser = null;
  let passwordSequence = null; // kept in memory for API key encryption
  let apiKey = null; // decrypted API key in memory
  let isLoggingIn = false;
  let isSyncing = false;
  let settings = {};
  let sentences = {}; // { id: { chinese, english, driveFileId, createdAt, lastReview, nextReview, level, correct, incorrect, easeFactor } }
  let studyDays = [];
  let todayPlan = null;

  // ===== INIT =====
  function init() {
    loadSettings();
    loadLocalData();
    setupLoginListeners();
    setupNavListeners();
    setupSettingsListeners();
    setupAddModeListeners();
    setupTrainingListeners();
    checkSession();
  }

  // ===== LOCAL PERSISTENCE =====
  function loadSettings() {
    try {
      settings = JSON.parse(localStorage.getItem(CONFIG.SETTINGS_KEY)) || {};
    } catch (_) {
      settings = {};
    }
  }

  function saveSettings() {
    localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadLocalData() {
    try {
      var stored = JSON.parse(localStorage.getItem(CONFIG.DATA_KEY));
      if (stored) {
        sentences = stored.sentences || {};
        studyDays = stored.studyDays || [];
        todayPlan = stored.todayPlan || null;
      }
    } catch (_) {
      sentences = {};
      studyDays = [];
      todayPlan = null;
    }
    normalizeStoredDates();
  }

  function saveLocalData() {
    localStorage.setItem(CONFIG.DATA_KEY, JSON.stringify({
      sentences: sentences,
      studyDays: studyDays,
      todayPlan: todayPlan
    }));
  }

  function normalizeStoredDates() {
    var changed = false;
    Object.values(sentences).forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      ['lastReview', 'nextReview', 'createdAt'].forEach(function (field) {
        if (s[field]) {
          var norm = normalizeDateField(s[field]);
          if (norm !== s[field]) { s[field] = norm; changed = true; }
        }
      });
    });
    if (changed) saveLocalData();
  }

  function normalizeDateField(val) {
    if (!val) return '';
    var s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (s.indexOf('T') > -1) {
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(s));
      } catch (_) {}
    }
    return s;
  }

  function getTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  }

  // ===== SESSION =====
  function checkSession() {
    try {
      var session = JSON.parse(sessionStorage.getItem(CONFIG.SESSION_KEY));
      if (session && session.user) {
        currentUser = session.user;
        if (session.seq) passwordSequence = session.seq;
        if (session.apiKey) apiKey = session.apiKey;
        showMainApp();
        return;
      }
    } catch (_) {}
    showLoginScreen();
  }

  function saveSession(user) {
    var data = { user: user };
    if (passwordSequence) data.seq = passwordSequence;
    if (apiKey) data.apiKey = apiKey;
    sessionStorage.setItem(CONFIG.SESSION_KEY, JSON.stringify(data));
  }

  function clearSession() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    currentUser = null;
    passwordSequence = null;
    apiKey = null;
  }

  // ===== CRYPTO (AES-GCM) =====
  async function deriveKey(password) {
    var enc = new TextEncoder();
    var keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(CONFIG.CRYPTO_SALT), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptText(plaintext, password) {
    var key = await deriveKey(password);
    var enc = new TextEncoder();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      enc.encode(plaintext)
    );
    var combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return btoa(String.fromCharCode.apply(null, combined));
  }

  async function decryptText(encryptedBase64, password) {
    var key = await deriveKey(password);
    var raw = Uint8Array.from(atob(encryptedBase64), function (c) { return c.charCodeAt(0); });
    var iv = raw.slice(0, 12);
    var data = raw.slice(12);
    var decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      data
    );
    return new TextDecoder().decode(decrypted);
  }

  // ===== LOGIN =====
  function setupLoginListeners() {
    document.querySelectorAll('.pad-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (isLoggingIn) return;
        var key = btn.getAttribute('data-key');
        if (currentSequence.length < CONFIG.SEQUENCE_LENGTH) {
          currentSequence.push(key);
          renderDots();
          updateLoginButton();
        }
      });
    });

    document.getElementById('btn-clear').addEventListener('click', function () {
      if (isLoggingIn) return;
      clearSequence();
    });

    document.getElementById('btn-login').addEventListener('click', function () {
      if (isLoggingIn) return;
      attemptLogin();
    });
  }

  function clearSequence() {
    currentSequence = [];
    renderDots();
    updateLoginButton();
    hideLoginError();
  }

  function renderDots() {
    var container = document.getElementById('sequence-dots');
    container.innerHTML = '';
    for (var i = 0; i < currentSequence.length; i++) {
      var dot = document.createElement('div');
      dot.className = 'seq-dot';
      container.appendChild(dot);
    }
  }

  function updateLoginButton() {
    var btn = document.getElementById('btn-login');
    btn.disabled = currentSequence.length < CONFIG.SEQUENCE_LENGTH;
  }

  function showLoginError(msg) {
    var el = document.getElementById('login-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    var container = document.querySelector('.login-pad');
    container.classList.add('shake');
    setTimeout(function () { container.classList.remove('shake'); }, 400);
  }

  function hideLoginError() {
    var el = document.getElementById('login-error');
    el.textContent = '';
    el.classList.add('hidden');
  }

  async function attemptLogin() {
    if (currentSequence.length !== CONFIG.SEQUENCE_LENGTH) return;

    isLoggingIn = true;
    var btn = document.getElementById('btn-login');
    btn.textContent = 'Verifying...';
    btn.disabled = true;
    hideLoginError();

    try {
      var sequence = currentSequence.join('');
      var resp = await gasRequest({ action: 'login', sequence: sequence });

      if (resp.success) {
        currentUser = resp.user;
        passwordSequence = sequence;

        // Decrypt API key if available
        if (resp.hasApiKey && resp.encryptedApiKey) {
          try {
            apiKey = await decryptText(resp.encryptedApiKey, sequence);
          } catch (_) {
            apiKey = null;
          }
        }

        saveSession(resp.user);
        showToast('Welcome, ' + resp.user + '!');
        showMainApp();
      } else {
        showLoginError(resp.error || 'Login failed');
        clearSequence();
      }
    } catch (err) {
      showLoginError('Network error. Please try again.');
      clearSequence();
    } finally {
      isLoggingIn = false;
      btn.textContent = 'Unlock';
    }
  }

  // ===== SYNC =====
  async function syncWithSheet(silent) {
    if (isSyncing || !currentUser) return;
    isSyncing = true;

    var syncBtn = document.getElementById('sync-btn');
    syncBtn.classList.add('syncing');
    if (!silent) showToast('Syncing...');

    try {
      // Step 1: Download remote data
      var remote = await gasGet({ action: 'getSentences', user: currentUser });

      // Step 2: Merge remote into local
      mergeSentences(remote.sentences || {});
      mergeStudyDays(remote.studyDays || []);
      if (remote.todayPlan) {
        var localDate = todayPlan ? todayPlan.date : null;
        var remoteDate = remote.todayPlan.date || null;
        if (remoteDate && remoteDate >= (localDate || '')) {
          todayPlan = remote.todayPlan;
        }
      }
      saveLocalData();

      // Step 3: Upload merged data to remote
      var progressData = {};
      Object.keys(sentences).forEach(function (id) {
        var s = sentences[id];
        progressData[id] = {
          chinese: s.chinese,
          english: s.english,
          driveFileId: s.driveFileId || '',
          createdAt: s.createdAt || '',
          lastReview: s.lastReview || '',
          nextReview: s.nextReview || '',
          level: s.level || 0,
          correct: s.correct || 0,
          incorrect: s.incorrect || 0,
          easeFactor: s.easeFactor || 2.5
        };
      });

      await gasRequest({
        action: 'saveProgress',
        user: currentUser,
        sentences: progressData,
        studyDays: studyDays,
        todayPlan: todayPlan
      });

      // Update sync timestamp
      var now = new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei'
      }).format(new Date());
      localStorage.setItem(CONFIG.SYNC_TIME_KEY, now);

      var syncTimeEl = document.getElementById('last-sync-time');
      if (syncTimeEl) syncTimeEl.textContent = now;

      if (!silent) showToast('Sync complete!');
    } catch (err) {
      console.error('Sync error:', err);
      if (!silent) showToast('Sync failed: ' + err.message);
    } finally {
      isSyncing = false;
      syncBtn.classList.remove('syncing');
    }
  }

  function mergeSentences(remoteSentences) {
    Object.keys(remoteSentences).forEach(function (id) {
      var remote = remoteSentences[id];
      var local = sentences[id];

      if (!local) {
        sentences[id] = remote;
        return;
      }

      // Merge: higher level wins; same level → more recent lastReview wins
      var rLevel = remote.level || 0;
      var lLevel = local.level || 0;
      if (rLevel > lLevel) {
        sentences[id] = remote;
      } else if (rLevel === lLevel) {
        var rDate = remote.lastReview || '';
        var lDate = local.lastReview || '';
        if (rDate > lDate) {
          sentences[id] = remote;
        }
      }
      // Keep driveFileId if remote has one and local doesn't
      if (remote.driveFileId && !sentences[id].driveFileId) {
        sentences[id].driveFileId = remote.driveFileId;
      }
    });
  }

  function mergeStudyDays(remoteDays) {
    var set = {};
    studyDays.forEach(function (d) { set[d] = true; });
    remoteDays.forEach(function (d) { if (!set[d]) studyDays.push(d); });
    studyDays.sort();
  }

  // ===== NAVIGATION =====
  function setupNavListeners() {
    document.getElementById('logout-btn').addEventListener('click', function () {
      clearSession();
      showLoginScreen();
    });

    document.getElementById('settings-btn').addEventListener('click', function () {
      showPage('settings');
      loadSettingsPage();
    });

    document.querySelector('.nav-brand').addEventListener('click', function () {
      showPage('dashboard');
    });

    // Global sync button in navbar
    document.getElementById('sync-btn').addEventListener('click', function () {
      syncWithSheet(false);
    });

    // Dashboard mode cards
    document.querySelectorAll('.mode-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var mode = card.getAttribute('data-mode');
        if (mode === 'add') {
          showPage('add');
          resetAddMode();
        } else if (mode === 'training') {
          showPage('training');
          loadTrainingPage();
        }
      });
    });
  }

  function showLoginScreen() {
    document.getElementById('login-screen').classList.add('active');
    document.getElementById('main-app').classList.remove('active');
    document.getElementById('main-app').classList.add('hidden');
    clearSequence();
  }

  function showMainApp() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('main-app').classList.add('active');
    showPage('dashboard');
    updateDashboardDate();
  }

  function showPage(name) {
    document.querySelectorAll('#content .page').forEach(function (p) {
      p.classList.remove('active');
      p.classList.add('hidden');
    });
    var page = document.getElementById('page-' + name);
    if (page) {
      page.classList.remove('hidden');
      page.classList.add('active');
    }
  }

  function updateDashboardDate() {
    var el = document.getElementById('dashboard-date');
    if (el) {
      el.textContent = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        timeZone: 'Asia/Taipei'
      }).format(new Date());
    }
  }

  // ===== SETTINGS PAGE =====
  function setupSettingsListeners() {
    document.getElementById('settings-back-btn').addEventListener('click', function () {
      showPage('dashboard');
    });

    // Toggle API key visibility
    document.getElementById('toggle-api-key').addEventListener('click', function () {
      var input = document.getElementById('api-key-input');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    // Save API key
    document.getElementById('save-api-key-btn').addEventListener('click', saveApiKey);

    // TTS voice selection
    document.getElementById('tts-voice-select').addEventListener('change', function () {
      settings.ttsVoice = this.value;
      saveSettings();
    });

    // TTS rate
    document.getElementById('tts-rate-range').addEventListener('input', function () {
      document.getElementById('tts-rate-value').textContent = this.value;
      settings.ttsRate = parseFloat(this.value);
      saveSettings();
    });

    // TTS test
    document.getElementById('tts-test-btn').addEventListener('click', function () {
      speak('Hello! This is a test of the text to speech voice.');
    });

    // Manual sync (same as navbar sync)
    document.getElementById('manual-sync-btn').addEventListener('click', function () {
      syncWithSheet(false);
    });

    // Populate voices when available
    if (window.speechSynthesis) {
      speechSynthesis.onvoiceschanged = populateVoices;
      populateVoices();
    }
  }

  function loadSettingsPage() {
    // API key status
    var statusEl = document.getElementById('api-key-status');
    var input = document.getElementById('api-key-input');

    if (apiKey) {
      statusEl.textContent = 'API Key is set and active.';
      statusEl.className = 'api-key-status saved';
      input.placeholder = 'API key saved (enter new to replace)';
    } else {
      statusEl.textContent = 'No API Key configured.';
      statusEl.className = 'api-key-status error';
      input.placeholder = 'Enter your API key';
    }
    input.value = '';

    // TTS settings
    var rate = settings.ttsRate || 1.0;
    document.getElementById('tts-rate-range').value = rate;
    document.getElementById('tts-rate-value').textContent = rate;
    populateVoices();

    // Last sync time
    var lastSync = localStorage.getItem(CONFIG.SYNC_TIME_KEY);
    document.getElementById('last-sync-time').textContent = lastSync || 'Never';
  }

  async function saveApiKey() {
    var input = document.getElementById('api-key-input');
    var key = input.value.trim();
    if (!key) {
      showToast('Please enter an API key');
      return;
    }
    if (!passwordSequence) {
      showToast('Session expired. Please log in again.');
      return;
    }

    var btn = document.getElementById('save-api-key-btn');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      var encrypted = await encryptText(key, passwordSequence);
      var resp = await gasRequest({ action: 'saveApiKey', user: currentUser, encryptedKey: encrypted });

      if (resp.success) {
        apiKey = key;
        saveSession(currentUser);
        var statusEl = document.getElementById('api-key-status');
        statusEl.textContent = 'API Key saved and synced!';
        statusEl.className = 'api-key-status saved';
        input.value = '';
        input.placeholder = 'API key saved (enter new to replace)';
        showToast('API Key saved');
      } else {
        showToast('Failed to save: ' + (resp.error || 'Unknown error'));
      }
    } catch (err) {
      showToast('Network error. Please try again.');
    } finally {
      btn.textContent = 'Save API Key';
      btn.disabled = false;
    }
  }

  // ===== ADD MODE =====
  let addInputMode = 'chinese'; // 'chinese' or 'english'
  let generatedOptions = [];
  let selectedOption = null;
  let addOriginalInput = '';

  function setupAddModeListeners() {
    document.getElementById('add-back-btn').addEventListener('click', function () {
      showPage('dashboard');
    });

    // Input mode toggle
    document.querySelectorAll('.toggle-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.toggle-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        addInputMode = btn.getAttribute('data-input');
        var textarea = document.getElementById('add-input');
        textarea.placeholder = addInputMode === 'chinese' ? '輸入中文句子...' : 'Type an English sentence...';
        document.getElementById('generate-btn').textContent =
          addInputMode === 'chinese' ? 'Generate English Options' : 'Improve & Generate Alternatives';
        resetAddMode();
      });
    });

    // Generate button
    document.getElementById('generate-btn').addEventListener('click', generateOptions);

    // Save button
    document.getElementById('save-sentence-btn').addEventListener('click', saveSentence);

    // Preview TTS
    document.getElementById('play-preview-btn').addEventListener('click', function () {
      var text = document.getElementById('save-english').textContent;
      if (text) speak(text);
    });
  }

  function resetAddMode() {
    generatedOptions = [];
    selectedOption = null;
    addOriginalInput = '';
    document.getElementById('add-input').value = '';
    document.getElementById('options-area').classList.add('hidden');
    document.getElementById('save-area').classList.add('hidden');
    document.getElementById('generate-loading').classList.add('hidden');
    document.getElementById('options-list').innerHTML = '';
  }

  async function generateOptions() {
    var input = document.getElementById('add-input').value.trim();
    if (!input) {
      showToast('Please enter a sentence');
      return;
    }
    if (!apiKey) {
      showToast('Please set your Gemini API Key in Settings first');
      return;
    }

    addOriginalInput = input;
    document.getElementById('generate-btn').disabled = true;
    document.getElementById('generate-loading').classList.remove('hidden');
    document.getElementById('options-area').classList.add('hidden');
    document.getElementById('save-area').classList.add('hidden');

    try {
      var prompt;
      if (addInputMode === 'chinese') {
        prompt = 'You are a helpful English tutor. Translate the following Chinese sentence into 3 different common English sentences. ' +
          'Prefer simple, natural, everyday English (Basic English level). ' +
          'Return ONLY a JSON array of 3 strings, no explanation.\n\n' +
          'Chinese: ' + input;
      } else {
        prompt = 'You are a helpful English tutor. Given the following English sentence, provide 4 options:\n' +
          '1. The original sentence with grammar and spelling corrected (label it "Corrected")\n' +
          '2-4. Three alternative ways to express the same meaning using simpler, more common English (Basic English level)\n\n' +
          'Return ONLY a JSON object with two keys:\n' +
          '- "corrected": the corrected version of the original\n' +
          '- "alternatives": an array of 3 alternative sentences\n\n' +
          'English: ' + input;
      }

      var result = await callGemini(prompt);
      parseAndShowOptions(result);
    } catch (err) {
      showToast('AI generation failed: ' + err.message);
    } finally {
      document.getElementById('generate-btn').disabled = false;
      document.getElementById('generate-loading').classList.add('hidden');
    }
  }

  async function callGemini(prompt) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey;
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7 }
      })
    });

    if (!resp.ok) {
      var errData = await resp.json().catch(function () { return {}; });
      throw new Error(errData.error ? errData.error.message : 'API error ' + resp.status);
    }

    var data = await resp.json();
    var text = data.candidates[0].content.parts[0].text;
    // Strip markdown code fences if present
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(text);
  }

  function parseAndShowOptions(result) {
    generatedOptions = [];
    var listEl = document.getElementById('options-list');
    listEl.innerHTML = '';

    if (addInputMode === 'chinese') {
      // result is an array of 3 strings
      var arr = Array.isArray(result) ? result : [];
      arr.forEach(function (text, i) {
        generatedOptions.push({ text: text, label: 'Option ' + (i + 1) });
      });
    } else {
      // result is { corrected, alternatives }
      if (result.corrected) {
        generatedOptions.push({ text: result.corrected, label: 'Corrected' });
      }
      (result.alternatives || []).forEach(function (text, i) {
        generatedOptions.push({ text: text, label: 'Alternative ' + (i + 1) });
      });
    }

    generatedOptions.forEach(function (opt, i) {
      var card = document.createElement('div');
      card.className = 'option-card';
      card.innerHTML = '<div class="option-badge">' + opt.label + '</div><div>' + escapeHtml(opt.text) + '</div>';
      card.addEventListener('click', function () {
        selectOption(i);
      });
      listEl.appendChild(card);
    });

    document.getElementById('options-area').classList.remove('hidden');
  }

  function selectOption(index) {
    selectedOption = generatedOptions[index];

    // Update visual selection
    document.querySelectorAll('.option-card').forEach(function (card, i) {
      card.classList.toggle('selected', i === index);
    });

    // Show save area
    var chinese, english;
    if (addInputMode === 'chinese') {
      chinese = addOriginalInput;
      english = selectedOption.text;
    } else {
      chinese = addOriginalInput;
      english = selectedOption.text;
    }

    document.getElementById('save-chinese').textContent = chinese;
    document.getElementById('save-english').textContent = english;
    document.getElementById('save-area').classList.remove('hidden');
  }

  async function saveSentence() {
    if (!selectedOption) return;

    var chinese = document.getElementById('save-chinese').textContent;
    var english = document.getElementById('save-english').textContent;

    var btn = document.getElementById('save-sentence-btn');
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      // Save to Google Sheet
      var resp = await gasRequest({
        action: 'addSentence',
        user: currentUser,
        chinese: chinese,
        english: english
      });

      if (resp.success) {
        // Also save locally
        var id = resp.id;
        var today = getTodayStr();
        sentences[id] = {
          chinese: chinese,
          english: english,
          driveFileId: '',
          createdAt: today,
          lastReview: '',
          nextReview: today,
          level: 0,
          correct: 0,
          incorrect: 0,
          easeFactor: 2.5
        };
        saveLocalData();

        showToast('Sentence saved!');
        resetAddMode();
      } else {
        showToast('Save failed: ' + (resp.error || 'Unknown error'));
      }
    } catch (err) {
      showToast('Network error: ' + err.message);
    } finally {
      btn.textContent = 'Save to Library';
      btn.disabled = false;
    }
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== TRAINING MODE =====
  let trainingMode = ''; // 'flashcard', 'spelling', 'reading'
  let sessionQueue = [];
  let sessionIndex = 0;
  let sessionResults = { good: 0, ok: 0, forgot: 0 };

  function setupTrainingListeners() {
    document.getElementById('training-back-btn').addEventListener('click', function () {
      showPage('dashboard');
    });

    document.getElementById('go-add-btn').addEventListener('click', function () {
      showPage('add');
      resetAddMode();
    });

    // Training mode cards
    document.querySelectorAll('[data-train]').forEach(function (card) {
      card.addEventListener('click', function () {
        var mode = card.getAttribute('data-train');
        startTrainingSession(mode);
      });
    });

    // Flashcard tap to reveal
    document.getElementById('flashcard').addEventListener('click', function () {
      var back = document.getElementById('flashcard-back');
      if (back.classList.contains('hidden')) {
        back.classList.remove('hidden');
        document.querySelector('.card-hint').style.display = 'none';
        document.getElementById('flash-eval').classList.remove('hidden');
      }
    });

    document.getElementById('flash-speak-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      var text = document.getElementById('flash-english').textContent;
      if (text) speak(text);
    });

    // Spelling check
    document.getElementById('spell-check-btn').addEventListener('click', checkSpelling);

    document.getElementById('spell-speak-btn').addEventListener('click', function () {
      var text = document.getElementById('spell-answer-text').textContent;
      if (text) speak(text);
    });

    // Reading play buttons
    document.getElementById('read-play-btn').addEventListener('click', function () {
      var text = document.getElementById('read-english').textContent;
      if (text) speak(text);
    });

    document.getElementById('read-slow-btn').addEventListener('click', function () {
      var text = document.getElementById('read-english').textContent;
      if (text) speakSlow(text);
    });

    // Summary done
    document.getElementById('summary-done-btn').addEventListener('click', function () {
      showPage('dashboard');
    });

    // All eval buttons (flashcard, spelling, reading)
    document.querySelectorAll('.btn-eval').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var result = btn.getAttribute('data-result');
        recordResult(result);
        nextSessionItem();
      });
    });
  }

  function loadTrainingPage() {
    var total = Object.keys(sentences).length;
    var today = getTodayStr();
    var due = 0;
    var mastered = 0;

    Object.values(sentences).forEach(function (s) {
      if ((s.level || 0) >= CONFIG.MAX_LEVEL) mastered++;
      var nr = s.nextReview || '';
      if (!nr || nr <= today) due++;
    });

    document.getElementById('train-due-count').textContent = Math.min(due, CONFIG.DAILY_MAX);
    document.getElementById('train-total-count').textContent = total;
    document.getElementById('train-mastered-count').textContent = mastered;

    if (total === 0) {
      document.getElementById('no-sentences-msg').classList.remove('hidden');
      document.getElementById('training-modes').classList.add('hidden');
      document.getElementById('training-stats').classList.add('hidden');
    } else {
      document.getElementById('no-sentences-msg').classList.add('hidden');
      document.getElementById('training-modes').classList.remove('hidden');
      document.getElementById('training-stats').classList.remove('hidden');
    }
  }

  // Spaced repetition: select today's sentences
  function selectDailySentences() {
    var today = getTodayStr();
    var ids = Object.keys(sentences);
    if (ids.length === 0) return [];

    // Separate due and not-yet-due
    var dueItems = [];
    var newItems = [];

    ids.forEach(function (id) {
      var s = sentences[id];
      var nr = s.nextReview || '';
      if (!nr || nr <= today) {
        var overdueDays = 0;
        if (nr) {
          overdueDays = Math.max(0, daysBetween(nr, today));
        }
        dueItems.push({ id: id, overdue: overdueDays, level: s.level || 0 });
      }
    });

    // Sort: most overdue first, then lowest level first
    dueItems.sort(function (a, b) {
      if (b.overdue !== a.overdue) return b.overdue - a.overdue;
      return a.level - b.level;
    });

    var selected = dueItems.slice(0, CONFIG.DAILY_MAX).map(function (item) { return item.id; });

    // If fewer than DAILY_MAX, add new items (never reviewed)
    if (selected.length < CONFIG.DAILY_MAX) {
      ids.forEach(function (id) {
        if (selected.length >= CONFIG.DAILY_MAX) return;
        if (selected.indexOf(id) === -1 && !(sentences[id].lastReview)) {
          selected.push(id);
        }
      });
    }

    // Deterministic shuffle using date seed
    var seed = parseInt(today.replace(/-/g, ''), 10);
    return seededShuffle(selected, seed);
  }

  function daysBetween(dateStr1, dateStr2) {
    var d1 = new Date(dateStr1 + 'T00:00:00');
    var d2 = new Date(dateStr2 + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000);
  }

  function seededShuffle(arr, seed) {
    var result = arr.slice();
    var rng = mulberry32(seed);
    for (var i = result.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = result[i];
      result[i] = result[j];
      result[j] = tmp;
    }
    return result;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function startTrainingSession(mode) {
    trainingMode = mode;
    sessionQueue = selectDailySentences();
    sessionIndex = 0;
    sessionResults = { good: 0, ok: 0, forgot: 0 };

    if (sessionQueue.length === 0) {
      showToast('No sentences due for review today!');
      return;
    }

    document.getElementById('session-total').textContent = sessionQueue.length;
    showPage('session');
    showSessionItem();
  }

  function showSessionItem() {
    if (sessionIndex >= sessionQueue.length) {
      finishSession();
      return;
    }

    var id = sessionQueue[sessionIndex];
    var s = sentences[id];
    var pct = Math.round((sessionIndex / sessionQueue.length) * 100);

    document.getElementById('session-current').textContent = sessionIndex + 1;
    document.getElementById('session-progress-fill').style.width = pct + '%';

    // Hide all modes
    document.querySelectorAll('.session-mode').forEach(function (el) { el.classList.add('hidden'); });

    if (trainingMode === 'flashcard') {
      document.getElementById('session-flashcard').classList.remove('hidden');
      document.getElementById('flash-chinese').textContent = s.chinese;
      document.getElementById('flash-english').textContent = s.english;
      document.getElementById('flashcard-back').classList.add('hidden');
      document.querySelector('.card-hint').style.display = '';
      document.getElementById('flash-eval').classList.add('hidden');

    } else if (trainingMode === 'spelling') {
      document.getElementById('session-spelling').classList.remove('hidden');
      document.getElementById('spell-chinese').textContent = s.chinese;
      document.getElementById('spell-input').value = '';
      document.getElementById('spell-result').classList.add('hidden');
      document.getElementById('spell-answer-text').textContent = s.english;
      document.getElementById('spell-input').focus();

    } else if (trainingMode === 'reading') {
      document.getElementById('session-reading').classList.remove('hidden');
      document.getElementById('read-english').textContent = s.english;
      document.getElementById('read-chinese').textContent = s.chinese;
    }
  }

  function checkSpelling() {
    var input = document.getElementById('spell-input').value.trim();
    if (!input) { showToast('Type your answer first'); return; }
    document.getElementById('spell-result').classList.remove('hidden');
    document.getElementById('spell-check-btn').disabled = true;
  }

  function recordResult(result) {
    var id = sessionQueue[sessionIndex];
    var s = sentences[id];
    var today = getTodayStr();

    if (result === 'good') {
      sessionResults.good++;
      s.correct = (s.correct || 0) + 1;
      s.level = Math.min((s.level || 0) + 1, CONFIG.MAX_LEVEL);
      s.easeFactor = Math.min((s.easeFactor || 2.5) + 0.1, 3.0);
    } else if (result === 'ok') {
      sessionResults.ok++;
      s.correct = (s.correct || 0) + 1;
      // Level stays the same
    } else {
      sessionResults.forgot++;
      s.incorrect = (s.incorrect || 0) + 1;
      s.level = Math.max((s.level || 0) - 1, 0);
      s.easeFactor = Math.max((s.easeFactor || 2.5) - 0.2, 1.3);
    }

    s.lastReview = today;
    var interval = CONFIG.INTERVALS[Math.min(s.level, CONFIG.MAX_LEVEL)] || 30;
    interval = Math.round(interval * (s.easeFactor || 2.5) / 2.5);
    var next = new Date();
    next.setDate(next.getDate() + interval);
    s.nextReview = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(next);

    sentences[id] = s;
    saveLocalData();
  }

  function nextSessionItem() {
    sessionIndex++;
    document.getElementById('spell-check-btn').disabled = false;
    showSessionItem();
  }

  function finishSession() {
    // Record study day
    var today = getTodayStr();
    if (studyDays.indexOf(today) === -1) {
      studyDays.push(today);
    }
    saveLocalData();

    // Update progress bar to 100%
    document.getElementById('session-progress-fill').style.width = '100%';

    // Show summary
    document.getElementById('sum-total').textContent = sessionQueue.length;
    document.getElementById('sum-good').textContent = sessionResults.good;
    document.getElementById('sum-ok').textContent = sessionResults.ok;
    document.getElementById('sum-forgot').textContent = sessionResults.forgot;
    showPage('summary');

    // Auto-sync after session
    syncWithSheet(true);
  }

  function speakSlow(text) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.6;
    var voices = speechSynthesis.getVoices();
    if (settings.ttsVoice) {
      var voice = voices.find(function (v) { return v.name === settings.ttsVoice; });
      if (voice) utterance.voice = voice;
    }
    speechSynthesis.speak(utterance);
  }

  // ===== TTS =====
  function populateVoices() {
    if (!window.speechSynthesis) return;
    var voices = speechSynthesis.getVoices();
    var select = document.getElementById('tts-voice-select');
    if (!select || voices.length === 0) return;

    var englishVoices = voices.filter(function (v) { return v.lang.startsWith('en'); });
    select.innerHTML = '';
    englishVoices.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name + ' (' + v.lang + ')';
      if (settings.ttsVoice === v.name) opt.selected = true;
      select.appendChild(opt);
    });

    if (!settings.ttsVoice && englishVoices.length > 0) {
      settings.ttsVoice = englishVoices[0].name;
    }
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    var utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = settings.ttsRate || 1.0;
    var voices = speechSynthesis.getVoices();
    if (settings.ttsVoice) {
      var voice = voices.find(function (v) { return v.name === settings.ttsVoice; });
      if (voice) utterance.voice = voice;
    }
    speechSynthesis.speak(utterance);
  }

  // ===== NETWORK =====
  async function gasRequest(data) {
    var resp = await fetch(CONFIG.GAS_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(data)
    });
    return await resp.json();
  }

  async function gasGet(params) {
    var url = CONFIG.GAS_URL + '?' + new URLSearchParams(params).toString();
    var resp = await fetch(url, { redirect: 'follow' });
    return await resp.json();
  }

  // ===== TOAST =====
  function showToast(msg, duration) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
      el.classList.add('hidden');
    }, duration || 3000);
  }

  // ===== START =====
  document.addEventListener('DOMContentLoaded', init);
})();
