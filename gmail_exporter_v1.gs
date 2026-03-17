
// Read from Script Properties:
const props  = PropertiesService.getScriptProperties();
const API_BASE = props.getProperty('API_BASE');
const API_KEY  = props.getProperty('API_KEY');
const BATCH_SIZE = 100;
const SEARCH_LIMIT = 1000;
const QUOTA_SAFETY_LIMIT = 18000; // stop before hitting 20k hard ceiling

function exportMessages() {
  let pageToken = props.getProperty('EXPORT_PAGE_TOKEN') || null;
  let totalExported = 0;
  let apiCalls = 0;
  let batch = [];
  let quotaExhausted = false;
  let errorMsg = null;

  const query = 'in:anywhere -in:sent -in:draft older_than:30d';

  try {
    do {
      const options = { maxResults: 500 };
      if (pageToken) options.pageToken = pageToken;

      let result;
      try {
        result = Gmail.Users.Messages.list('me', options);
        apiCalls++;
      } catch(e) {
        if (e.message.includes('quota') || e.message.includes('rate')) {
          quotaExhausted = true;
          errorMsg = 'Quota hit on Messages.list: ' + e.message;
          break;
        }
        throw e;
      }

      if (!result || !result.messages) break;

      for (const stub of result.messages) {
        // Check quota headroom before each message fetch
        if (apiCalls >= QUOTA_SAFETY_LIMIT) {
          quotaExhausted = true;
          errorMsg = 'Approaching quota ceiling at ' + apiCalls + ' calls. Stopping safely.';
          break;
        }

        let msg;
        try {
          msg = Gmail.Users.Messages.get('me', stub.id, {
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date']
          });
          apiCalls++;
        } catch(e) {
          if (e.message.includes('quota') || e.message.includes('rate')) {
            quotaExhausted = true;
            errorMsg = 'Quota hit on Messages.get after ' + apiCalls + ' calls: ' + e.message;
            break;
          }
          throw e;
        }

        const headers = {};
        (msg.payload.headers || []).forEach(h => headers[h.name] = h.value);

        const sender   = headers['From'] || '';
        const domain   = extractDomain(sender);
        const subject  = (headers['Subject'] || '').substring(0, 500);
        const dateStr  = headers['Date'] || '';
        let received;
        try {
          const d = new Date(dateStr);
          received = isNaN(d.getTime()) ? '1970-01-01 00:00:00' : d.toISOString().replace('T', ' ').substring(0, 19);
        } catch(e) {
          received = '1970-01-01 00:00:00';
        }
        const label    = (msg.labelIds || []).join(',').substring(0, 64);

        batch.push({
          thread_id:     msg.threadId,
          message_id:    msg.id,
          sender:        sender.substring(0, 255),
          sender_domain: domain.substring(0, 128),
          subject:       subject,
          received_date: received,
          label:         label
        });

        if (batch.length >= BATCH_SIZE) {
          postBatch(batch);
          totalExported += batch.length;
          batch = [];
          // Save progress after every batch in case of timeout
          props.setProperty('EXPORT_PAGE_TOKEN', pageToken || '');
          props.setProperty('DAILY_API_CALLS', apiCalls.toString());
        }

        if (totalExported >= SEARCH_LIMIT) break;
      }

      pageToken = result.nextPageToken || null;
      props.setProperty('EXPORT_PAGE_TOKEN', pageToken || '');

      if (quotaExhausted) break;

    } while (pageToken && totalExported < SEARCH_LIMIT);

  } catch(e) {
    errorMsg = 'Unexpected error after ' + apiCalls + ' calls: ' + e.message;
  }

  // Flush any remaining batch
  if (batch.length > 0) {
    postBatch(batch);
    totalExported += batch.length;
  }

  // Persist call count for visibility (resets manually or daily)
  props.setProperty('DAILY_API_CALLS', apiCalls.toString());

  // Summary log
  Logger.log('=== exportMessages summary ===');
  Logger.log('Messages exported this run: ' + totalExported);
  Logger.log('API calls this run: ' + apiCalls);
  Logger.log('Page token saved: ' + (pageToken ? 'yes (resumable)' : 'none'));
  if (quotaExhausted) {
    Logger.log('QUOTA WARNING: ' + errorMsg);
    Logger.log('Run again after quota resets (~8pm EDT or 10am EDT following day)');
  }
  if (errorMsg && !quotaExhausted) {
    Logger.log('ERROR: ' + errorMsg);
  }
}

function postBatch(batch) {
  const response = UrlFetchApp.fetch(API_BASE + '/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-Key': API_KEY },
    payload: JSON.stringify(batch),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('POST error: ' + response.getContentText());
  }
}

function extractDomain(sender) {
  const match = sender.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : 'unknown';
}

function resetExportPointer() {
  PropertiesService.getScriptProperties().deleteProperty('EXPORT_PAGE_TOKEN');
  PropertiesService.getScriptProperties().deleteProperty('DAILY_API_CALLS');
  Logger.log('Export pointer and call counter reset.');
}
function trashFlagged() {
  const START_TIME = new Date();
  const MAX_RUNTIME_MS = 300000; // 5 minutes
  const scriptProps = PropertiesService.getScriptProperties();
  const apiBase = scriptProps.getProperty('API_BASE');
  const apiKey  = scriptProps.getProperty('API_KEY');
  const TRASH_BATCH_SIZE = 20;

  let totalTrashed = 0;
  let totalErrors  = 0;
  let quotaExhausted = false;

  // Fetch flagged message IDs from the API
  let ids;
  try {
    const response = UrlFetchApp.fetch(apiBase + '/flagged', {
      method: 'get',
      headers: { 'X-API-Key': apiKey },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('ERROR fetching flagged list: ' + response.getContentText());
      return;
    }
    ids = JSON.parse(response.getContentText());
  } catch(e) {
    Logger.log('ERROR fetching flagged list: ' + e.message);
    return;
  }

  if (ids.length === 0) {
    Logger.log('No flagged messages to trash.');
    return;
  }

  Logger.log('Flagged messages to trash: ' + ids.length);

  // Process in batches
  for (let i = 0; i < ids.length; i += TRASH_BATCH_SIZE) {
      if (new Date() - START_TIME > MAX_RUNTIME_MS) {
        Logger.log('Approaching time limit — stopping cleanly.');
        break;
      }
    const batch = ids.slice(i, i + TRASH_BATCH_SIZE);
    const trashed = [];

    for (const id of batch) {
      try {
        GmailApp.getMessageById(id).moveToTrash();
        trashed.push(id);
        totalTrashed++;
      } catch(e) {
        if (e.message.includes('quota') || e.message.includes('rate')) {
          quotaExhausted = true;
          Logger.log('QUOTA WARNING at message ' + totalTrashed + ': ' + e.message);
          break;
        }
        // Message not found or already trashed — skip it
        totalErrors++;
      }
    }

    // Confirm trashed batch back to API
  if (trashed.length > 0) {
    let confirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = UrlFetchApp.fetch(apiBase + '/trashed', {
          method: 'post',
          contentType: 'application/json',
          headers: { 'X-API-Key': apiKey },
          payload: JSON.stringify(trashed),
          muteHttpExceptions: true
        });
        if (r.getResponseCode() === 200) { confirmed = true; break; }
      } catch(e) {
        Utilities.sleep(2000);
      }
    }
    if (!confirmed) Logger.log('WARNING: Could not confirm batch to DB after 3 attempts.');
  }

    if (quotaExhausted) break;
  }

  // Summary
  Logger.log('=== trashFlagged summary ===');
  Logger.log('Total trashed: ' + totalTrashed);
  Logger.log('Total errors (skipped): ' + totalErrors);
  if (quotaExhausted) {
    Logger.log('QUOTA WARNING: stopped early. Run again after quota resets.');
    Logger.log('Already-trashed messages are marked in DB — no double-trashing.');
  }
}
function dailyReport() {
  const scriptProps = PropertiesService.getScriptProperties();
  const apiBase = scriptProps.getProperty('API_BASE');
  const apiKey  = scriptProps.getProperty('API_KEY');

  const response = UrlFetchApp.fetch(apiBase + '/stats', {
    method: 'get',
    headers: { 'X-API-Key': apiKey },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    Logger.log('ERROR fetching stats: ' + response.getContentText());
    return;
  }

  const data = JSON.parse(response.getContentText());
  const t = data.totals;
  const domains = data.domains;

  const now = Utilities.formatDate(new Date(), 'America/New_York', 'MMM d, yyyy h:mm a');

  let rows = '';
  for (const d of domains) {
    const pctTrashed = d.total > 0 ? Math.round((d.trashed / d.total) * 100) : 0;
    rows += `
      <tr>
        <td>${d.sender_domain}</td>
        <td align="right">${d.total}</td>
        <td align="right">${d.flagged}</td>
        <td align="right">${d.trashed}</td>
        <td align="right">${pctTrashed}%</td>
      </tr>`;
  }

  const html = `
    <html><body style="font-family: Arial, sans-serif; font-size: 14px; color: #222;">
    <h2 style="color: #1a73e8;">Gmail Cleaner Daily Report</h2>
    <p>${now} EDT</p>

    <table style="border-collapse: collapse; margin-bottom: 24px;">
      <tr>
        <td style="padding: 6px 16px 6px 0;"><b>Total messages in DB:</b></td>
        <td>${Number(t.total_messages).toLocaleString()}</td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 6px 0;"><b>Total flagged:</b></td>
        <td>${Number(t.total_flagged).toLocaleString()}</td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 6px 0;"><b>Total trashed:</b></td>
        <td>${Number(t.total_trashed).toLocaleString()}</td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 6px 0;"><b>Unique domains:</b></td>
        <td>${Number(t.total_domains).toLocaleString()}</td>
      </tr>
    </table>

    <h3>Top 30 Domains</h3>
    <table style="border-collapse: collapse; width: 100%;">
      <thead>
        <tr style="background: #1a73e8; color: white;">
          <th style="padding: 8px 12px; text-align: left;">Domain</th>
          <th style="padding: 8px 12px; text-align: right;">Total</th>
          <th style="padding: 8px 12px; text-align: right;">Flagged</th>
          <th style="padding: 8px 12px; text-align: right;">Trashed</th>
          <th style="padding: 8px 12px; text-align: right;">% Done</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    </body></html>`;

  GmailApp.sendEmail(
    'jim.shaffer@gmail.com',
    'Gmail Cleaner Report — ' + now,
    'This report requires an HTML-capable email client.',
    { htmlBody: html }
  );

  Logger.log('Daily report sent.');
}
