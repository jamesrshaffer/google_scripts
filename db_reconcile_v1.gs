// db_reconcile_v1.gs
// Reconcile DB rows where flagged_delete=1, trashed=0 against live Gmail state.
// Actions:
//   Not found in Gmail → purge row from DB (chunked 50 at a time)
//   TRASH label        → mark trashed=1 in DB
//   exists/active      → no action (logged)

function reconcileFlagged() {
  const props = PropertiesService.getScriptProperties();
  const API_BASE = props.getProperty('API_BASE');
  const API_KEY  = props.getProperty('API_KEY');

  let ids;
  try {
    const r = UrlFetchApp.fetch(API_BASE + '/flagged', {
      headers: { 'X-API-Key': API_KEY },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) {
      Logger.log('ERROR fetching /flagged: ' + r.getContentText());
      return;
    }
    ids = JSON.parse(r.getContentText());
  } catch(e) {
    Logger.log('ERROR fetching /flagged: ' + e.message);
    return;
  }

  Logger.log('Rows to reconcile: ' + ids.length);
  if (ids.length === 0) return;

  const toPurge = [];
  const toTrash = [];
  let   skipped = 0;
  let   errors  = 0;

  for (const id of ids) {
    try {
      const msg = Gmail.Users.Messages.get('me', id, { fields: 'id,labelIds' });
      if ((msg.labelIds || []).includes('TRASH')) {
        toTrash.push(id);
      } else {
        skipped++;
      }
    } catch(e) {
      if (e.message.includes('Requested entity was not found') ||
          e.message.includes('404') ||
          e.message.includes('Not Found')) {
        toPurge.push(id);
      } else {
        Logger.log('WARN unexpected error for ' + id + ': ' + e.message);
        errors++;
      }
    }
  }

  // Purge non-existent rows — chunked 50 at a time to avoid 502
  const PURGE_CHUNK = 50;
  let purgeErrors = 0;
  for (let i = 0; i < toPurge.length; i += PURGE_CHUNK) {
    const chunk = toPurge.slice(i, i + PURGE_CHUNK);
    const r = UrlFetchApp.fetch(API_BASE + '/messages/purge', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-API-Key': API_KEY },
      payload: JSON.stringify(chunk),
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) {
      Logger.log('ERROR on /messages/purge chunk ' + i + ': ' + r.getContentText());
      purgeErrors++;
    }
  }

  // Mark already-trashed rows
  if (toTrash.length > 0) {
    const r = UrlFetchApp.fetch(API_BASE + '/trashed', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-API-Key': API_KEY },
      payload: JSON.stringify(toTrash),
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) Logger.log('ERROR on /trashed: ' + r.getContentText());
  }

  if (purgeErrors > 0) {
    Logger.log('Purged (not in Gmail):     ' + toPurge.length + ' (' + purgeErrors + ' chunk errors)');
  } else {
    Logger.log('Purged (not in Gmail):     ' + toPurge.length);
  }
