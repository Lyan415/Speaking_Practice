/**
 * SpeakingPractice — Google Apps Script Backend
 *
 * Setup:
 * 1. Open the Google Sheet
 * 2. Extensions > Apps Script
 * 3. Delete existing code, paste this entire file
 * 4. Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web App URL
 */

const SPREADSHEET_ID = '1E-_9M4205Z5KC5YUR5hJ9VLXO0TLDKX_cc2Gd3pUAIs';
const SCRIPT_VERSION = 'v1-speaking-practice-2026-06-08';
const TIMEZONE = 'Asia/Taipei';
const DRIVE_FOLDER_ID = ''; // TODO: fill in after creating Drive folder

const SHEET_USERS = 'Users';
const SHEET_SENTENCES = 'Sentences';
const SHEET_STUDY_LOG = 'StudyLog';
const SHEET_META = 'Meta';
const SHEET_CONFIG = 'Config';

const PASSWORD_SALT = '_speaking_practice_salt_2026';
const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60000;

// ===== REQUEST ROUTING =====

function doGet(e) {
  const action = e.parameter.action || 'ping';

  if (action === 'ping') {
    return jsonResponse({ status: 'ok', version: SCRIPT_VERSION });
  }


  if (action === 'getSentences') {
    return jsonResponse(getSentences(e.parameter.user));
  }

  if (action === 'getAudio') {
    return serveAudioFile(e.parameter.fileId);
  }

  return jsonResponse({ error: 'Unknown action' });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'login') return jsonResponse(handleLogin(data.sequence));
    if (action === 'saveApiKey') return jsonResponse(saveApiKey(data.user, data.encryptedKey));
    if (action === 'getApiKey') return jsonResponse(getApiKey(data.user));
    if (action === 'addSentence') return jsonResponse(addSentence(data.user, data.chinese, data.english, data.driveFileId));
    if (action === 'saveProgress') return jsonResponse(saveProgress(data.user, data.sentences, data.studyDays, data.todayPlan));
    if (action === 'saveAudio') return jsonResponse(saveAudioToDrive(data.sentenceId, data.audioBase64, data.mimeType));
    if (action === 'updateSentenceAudio') return jsonResponse(updateSentenceAudio(data.sentenceId, data.user, data.driveFileId));

    return jsonResponse({ error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

// ===== AUTHENTICATION =====

function handleLogin(sequence) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const configSheet = ss.getSheetByName(SHEET_CONFIG);
  if (!configSheet) return { success: false, error: 'Config not found' };

  const configData = getConfigMap(configSheet);
  const storedHash = configData['passwordHash'] || '';

  // Rate limiting
  var rateLimit;
  try { rateLimit = JSON.parse(configData['rateLimit'] || '{}'); } catch (_) { rateLimit = {}; }
  if (!rateLimit.attempts) rateLimit = { attempts: 0, lastAttempt: 0 };

  const now = new Date().getTime();
  if (now - rateLimit.lastAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimit.attempts = 0;
  }

  if (rateLimit.attempts >= MAX_LOGIN_ATTEMPTS) {
    var wait = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - rateLimit.lastAttempt)) / 1000);
    return { success: false, error: 'Too many attempts. Wait ' + wait + 's.' };
  }

  const inputHash = computeSHA256(sequence + PASSWORD_SALT);

  rateLimit.attempts++;
  rateLimit.lastAttempt = now;
  setConfigValue(configSheet, 'rateLimit', JSON.stringify(rateLimit));

  if (inputHash !== storedHash) {
    return { success: false, error: 'Invalid password' };
  }

  // Success — reset rate limit
  setConfigValue(configSheet, 'rateLimit', JSON.stringify({ attempts: 0, lastAttempt: 0 }));

  // Ensure user row exists
  const usersSheet = ss.getSheetByName(SHEET_USERS);
  const username = findOrCreateUser(usersSheet, inputHash);

  // Return user info + encrypted API key
  var encryptedApiKey = getUserApiKey(usersSheet, username);

  return {
    success: true,
    user: username,
    hasApiKey: encryptedApiKey !== '',
    encryptedApiKey: encryptedApiKey
  };
}

function findOrCreateUser(usersSheet, passwordHash) {
  const data = usersSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === passwordHash) return data[i][0];
  }
  // Create default user
  var username = 'Lyan_Yeh';
  var today = formatDate(new Date());
  usersSheet.appendRow([username, passwordHash, '', today]);
  return username;
}

function getUserApiKey(usersSheet, username) {
  var data = usersSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === username) return data[i][2] || '';
  }
  return '';
}

// ===== API KEY MANAGEMENT =====

function saveApiKey(user, encryptedKey) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_USERS);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === user) {
      sheet.getRange(i + 1, 3).setValue(encryptedKey);
      return { success: true };
    }
  }
  return { success: false, error: 'User not found' };
}

function getApiKey(user) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_USERS);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === user) {
      return { success: true, encryptedApiKey: data[i][2] || '' };
    }
  }
  return { success: false, error: 'User not found' };
}

// ===== SENTENCES =====

function getSentences(user) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SENTENCES);
  if (!sheet) return { sentences: {}, studyDays: [], todayPlan: null };

  var data = sheet.getDataRange().getValues();
  var sentences = {};

  // Header: ID, User, Chinese, English, DriveFileID, CreatedAt, LastReview, NextReview, Level, Correct, Incorrect, EaseFactor
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0] || row[1] !== user) continue;
    sentences[row[0]] = {
      chinese: row[2] || '',
      english: row[3] || '',
      driveFileId: row[4] || '',
      createdAt: dateToStr(row[5]),
      lastReview: dateToStr(row[6]),
      nextReview: dateToStr(row[7]),
      level: row[8] || 0,
      correct: row[9] || 0,
      incorrect: row[10] || 0,
      easeFactor: row[11] || 2.5
    };
  }

  // Study days
  var studyDays = [];
  var logSheet = ss.getSheetByName(SHEET_STUDY_LOG);
  if (logSheet) {
    var logData = logSheet.getDataRange().getValues();
    for (var j = 1; j < logData.length; j++) {
      if (logData[j][1] === user) {
        var d = dateToStr(logData[j][0]);
        if (d) studyDays.push(d);
      }
    }
  }

  // Today's plan from Meta
  var todayPlan = getMetaValue(ss, 'todayPlan_' + user);

  return { sentences: sentences, studyDays: studyDays, todayPlan: todayPlan };
}

function addSentence(user, chinese, english, driveFileId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SENTENCES);
  if (!sheet) return { success: false, error: 'Sentences sheet not found' };

  var id = generateId();
  var today = formatDate(new Date());

  // Force date columns to plain text before writing
  forceDateColumnsToText(sheet);

  sheet.appendRow([id, user, chinese, english, driveFileId || '', today, '', today, 0, 0, 0, 2.5]);

  return { success: true, id: id };
}

function saveProgress(user, sentences, studyDays, todayPlan) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SENTENCES);
  if (!sheet) return { success: false, error: 'Sentences sheet not found' };

  var data = sheet.getDataRange().getValues();

  // Build index of existing rows by ID for this user
  var rowIndex = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][1] === user) {
      rowIndex[data[i][0]] = i + 1; // 1-based row number
    }
  }

  // Force date columns to plain text
  forceDateColumnsToText(sheet);

  // Update existing sentences or add new ones
  var keys = Object.keys(sentences);
  for (var k = 0; k < keys.length; k++) {
    var id = keys[k];
    var s = sentences[id];
    var rowNum = rowIndex[id];

    if (rowNum) {
      // Update progress columns only (G onwards): LastReview, NextReview, Level, Correct, Incorrect, EaseFactor
      sheet.getRange(rowNum, 7).setValue(s.lastReview || '');
      sheet.getRange(rowNum, 8).setValue(s.nextReview || '');
      sheet.getRange(rowNum, 9).setValue(s.level || 0);
      sheet.getRange(rowNum, 10).setValue(s.correct || 0);
      sheet.getRange(rowNum, 11).setValue(s.incorrect || 0);
      sheet.getRange(rowNum, 12).setValue(s.easeFactor || 2.5);
      // Also update DriveFileID if provided
      if (s.driveFileId) {
        sheet.getRange(rowNum, 5).setValue(s.driveFileId);
      }
    } else {
      // New sentence — append
      sheet.appendRow([
        id, user, s.chinese || '', s.english || '', s.driveFileId || '',
        s.createdAt || formatDate(new Date()),
        s.lastReview || '', s.nextReview || formatDate(new Date()),
        s.level || 0, s.correct || 0, s.incorrect || 0, s.easeFactor || 2.5
      ]);
    }
  }

  // Save study days
  if (studyDays && studyDays.length > 0) {
    var logSheet = ss.getSheetByName(SHEET_STUDY_LOG);
    if (logSheet) {
      var existingLogs = logSheet.getDataRange().getValues();
      var existingDates = {};
      for (var e = 1; e < existingLogs.length; e++) {
        if (existingLogs[e][1] === user) {
          existingDates[dateToStr(existingLogs[e][0])] = true;
        }
      }
      for (var d = 0; d < studyDays.length; d++) {
        if (!existingDates[studyDays[d]]) {
          logSheet.appendRow([studyDays[d], user, 0, 0, 0]);
        }
      }
    }
  }

  // Save today's plan to Meta
  if (todayPlan !== undefined && todayPlan !== null) {
    setMetaValue(ss, 'todayPlan_' + user, todayPlan);
  }

  return { success: true };
}

// ===== GOOGLE DRIVE AUDIO =====

function saveAudioToDrive(sentenceId, audioBase64, mimeType) {
  if (!DRIVE_FOLDER_ID) return { success: false, error: 'Drive folder not configured' };

  try {
    var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    var blob = Utilities.newBlob(Utilities.base64Decode(audioBase64), mimeType || 'audio/wav', sentenceId + '.wav');
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return { success: true, fileId: file.getId() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function updateSentenceAudio(sentenceId, user, driveFileId) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_SENTENCES);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(sentenceId) && data[i][1] === user) {
      sheet.getRange(i + 1, 5).setValue(driveFileId);
      return { success: true };
    }
  }
  return { success: false, error: 'Sentence not found' };
}

function serveAudioFile(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    var blob = file.getBlob();
    return ContentService.createTextOutput(Utilities.base64Encode(blob.getBytes()))
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    return jsonResponse({ error: 'Audio not found: ' + err.message });
  }
}

// ===== META SHEET HELPERS =====

function getMetaValue(ss, key) {
  var sheet = ss.getSheetByName(SHEET_META);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      try { return JSON.parse(data[i][1]); } catch (_) { return data[i][1]; }
    }
  }
  return null;
}

function setMetaValue(ss, key, value) {
  var sheet = ss.getSheetByName(SHEET_META);
  if (!sheet) return;
  var jsonVal = typeof value === 'string' ? value : JSON.stringify(value);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(jsonVal);
      return;
    }
  }
  sheet.appendRow([key, jsonVal]);
}

// ===== CONFIG SHEET HELPERS =====

function getConfigMap(configSheet) {
  var data = configSheet.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) map[data[i][0]] = data[i][1];
  }
  return map;
}

function setConfigValue(configSheet, key, value) {
  var data = configSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      configSheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  configSheet.appendRow([key, value]);
}

// ===== UTILITY =====

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function computeSHA256(input) {
  var rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return rawHash.map(function (b) {
    return ('0' + ((b < 0 ? b + 256 : b).toString(16))).slice(-2);
  }).join('');
}

function dateToStr(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, TIMEZONE, 'yyyy-MM-dd');
  }
  var s = String(val).trim();
  // Handle ISO timestamps
  if (s.indexOf('T') > -1) {
    try {
      var d = new Date(s);
      return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
    } catch (_) {}
  }
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function formatDate(d) {
  return Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
}

function forceDateColumnsToText(sheet) {
  var lastRow = sheet.getMaxRows();
  if (lastRow < 2) return;
  // Columns F(6), G(7), H(8) are date columns: CreatedAt, LastReview, NextReview
  sheet.getRange(2, 6, lastRow - 1, 3).setNumberFormat('@');
}

function generateId() {
  return 'sp_' + new Date().getTime() + '_' + Math.random().toString(36).substr(2, 6);
}
