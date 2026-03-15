const API_BASE = 'https://api.shafferassoc.com';
const API_KEY  = 'Q7F9K2W8RZ4H0MPLX3T8VJ5C9N2B6YD';
const BATCH_SIZE = 100;
const SEARCH_LIMIT = 10000;
const QUOTA_SAFETY_LIMIT = 18000; // stop before hitting 20k hard ceiling

function exportMessages() {
  const props = PropertiesService.getScriptProperties();
  let pageToken = props.getProperty('EXPORT_PAGE_TOKEN') || null;
  let totalExported = 0;
  let apiCalls = parseInt(props.getProperty('DAILY_API_CALLS') || '0');
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
