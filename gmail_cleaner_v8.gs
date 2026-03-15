// ============================================================
// Gmail Promotion Cleaner v8
// Jim Shaffer · jim.shaffer@gmail.com
// ============================================================

const CFG = {
  YEARS_OLD: 3,
  BATCH_LIMIT: 400,
  DISCOVERY_SCAN_SIZE: 500,
  MIN_COUNT_TO_LIST: 2,
  TIMEZONE: "America/New_York",

  SKIP_SENDERS: [
    // "FineWoodworking@e.taunton.com",
    // "News@email.americastestkitchen.com",
  ],

  PROTECTED_SENDERS: [
    "amazon", "ebay", "paypal", "bestbuy", "apple.com",
    "microsoft", "newegg", "bhphotovideo", "adorama",
    "staples", "homedepot", "target", "walmart", "costco",
    "fedex", "ups.com", "usps", "dhl", "fidelity", "schwab",
    "vanguard", "chase", "wellsfargo", "bankofamerica",
    "americanexpress", "amex", "discover", "cigna", "anthem",
    "uhc", "aetna", "delta", "united.com", "southwest",
    "aa.com", "marriott", "hilton", "hyatt", "hertz",
    "enterprise", "irs.gov", "noreply@fidsafe.com",
  ],

  ORDER_SUBJECT_KEYWORDS: [
    "order confirmation",
    "order #",
    "order number",
    "receipt for",
    "your receipt",
    "invoice #",
    "invoice number",
    "payment confirmation",
    "payment received",
    "shipping confirmation",
    "your shipment",
    "has shipped",
    "tracking number",
    "out for delivery",
    "reservation confirmation",
    "booking confirmation",
    "your itinerary",
    "e-ticket",
    "account statement",
    "statement is ready",
    "renewal confirmation",
    "purchase confirmation",
    "thank you for your purchase",
    "subscription confirmed",
  ],
};


// ── PUBLIC FUNCTIONS ───────────────────────────────────────────

function discoverSenders() {
  Logger.log("=== SENDER DISCOVERY === " + _nowStr());
  Logger.log("Scanning " + CFG.DISCOVERY_SCAN_SIZE + " threads older than " + CFG.YEARS_OLD + " years...");

  const senderMap = _buildSenderMap();

  if (senderMap.size === 0) {
    Logger.log("No qualifying senders found. Try increasing DISCOVERY_SCAN_SIZE.");
    return;
  }

  Logger.log("");
  Logger.log(_pad("COUNT", 6) + "  " + _pad("NAME", 28) + "  EMAIL");
  Logger.log("-".repeat(82));
  let total = 0;
  for (const [email, d] of senderMap) {
    Logger.log(_pad(String(d.count), 6) + "  " + _pad(d.name, 28) + "  " + email);
    total += d.count;
  }
  Logger.log("");
  Logger.log("Unique senders:          " + senderMap.size);
  Logger.log("Total trashable threads: ~" + total);
  Logger.log("(Protected senders already excluded)");
  Logger.log("Next: optionally add keepers to SKIP_SENDERS, then run trashBySender()");

  const props = PropertiesService.getScriptProperties();
  props.setProperty(
    "SENDER_LIST",
    JSON.stringify(
      Array.from(senderMap.entries()).map(([email, d]) => ({
        email: email, count: d.count, name: d.name,
      }))
    )
  );
  props.setProperty("SENDER_INDEX", "0");
  Logger.log("Sender list saved. Progress reset to start.");
}


function trashBySender() {
  const props = PropertiesService.getScriptProperties();
  let raw = props.getProperty("SENDER_LIST");

  if (!raw) {
    Logger.log("No sender list — running discoverSenders() first...");
    discoverSenders();
    raw = props.getProperty("SENDER_LIST");
  }

  const senders = JSON.parse(raw);
  if (!senders || senders.length === 0) {
    Logger.log("No senders to process. Run discoverSenders() first.");
    return;
  }

  let startIndex = parseInt(props.getProperty("SENDER_INDEX") || "0", 10);
  if (isNaN(startIndex) || startIndex < 0) startIndex = 0;

  if (startIndex >= senders.length) {
    Logger.log("=== All senders already processed! ===");
    Logger.log("Run discoverSenders() to scan for more, or resetProgress() to start over.");
    return;
  }

  Logger.log("=== TRASH BY SENDER === " + _nowStr());
  Logger.log(
    "Resuming at " + (startIndex + 1) + " of " + senders.length +
    "  (" + (senders.length - startIndex) + " remaining)"
  );
  Logger.log("");

  const cutoff = _getCutoffStr();
  let totalTrashed = 0;
  let totalKept = 0;
  let totalSkipped = 0;
  let lastIndex = startIndex;
  let quotaHit = false;

  for (let i = startIndex; i < senders.length; i++) {
    lastIndex = i;
    const s = senders[i];
    const pos = "[" + (i + 1) + "/" + senders.length + "]";

    if (totalTrashed >= CFG.BATCH_LIMIT) {
      Logger.log("Batch limit (" + CFG.BATCH_LIMIT + ") reached. Run again to continue.");
      break;
    }

    if (_isSkipped(s.email)) {
      Logger.log(pos + " SKIP (SKIP_SENDERS): " + s.email);
      totalSkipped++;
      props.setProperty("SENDER_INDEX", String(i + 1));
      continue;
    }

    const result = _trashSender(s.email, cutoff, pos, s.name);

    // Check for quota error — exit immediately, save progress
    if (result.quotaExhausted) {
      Logger.log("QUOTA EXHAUSTED at " + pos + " " + s.email);
      Logger.log("Progress saved at sender " + (i + 1) + ". Run again after quota resets.");
      // Do NOT advance the index — retry this sender next time
      quotaHit = true;
      break;
    }

    totalTrashed += result.trashed;
    totalKept += result.kept;
    props.setProperty("SENDER_INDEX", String(i + 1));

    Logger.log(
      pos + " " + s.email +
      "  ->  trashed " + result.trashed +
      (result.kept > 0 ? "  kept " + result.kept : "") +
      "  (session total: " + totalTrashed + ")"
    );

    Utilities.sleep(200);
  }

  Logger.log("");
  if (quotaHit) {
    Logger.log("=== Stopped: quota exhausted === " + _nowStr());
  } else if (lastIndex >= senders.length - 1 && totalTrashed < CFG.BATCH_LIMIT) {
    Logger.log("=== All senders processed === " + _nowStr());
    Logger.log("Run discoverSenders() to scan deeper into your inbox.");
    props.setProperty("SENDER_INDEX", String(senders.length));
  } else {
    Logger.log("=== Run complete === " + _nowStr());
    Logger.log("Run trashBySender() again to continue from sender " + (lastIndex + 2) + ".");
  }
  Logger.log(
    "Session trashed: " + totalTrashed +
    "  Kept: " + totalKept +
    "  Skipped senders: " + totalSkipped
  );
}


function trashAll() {
  Logger.log("=== TRASH ALL OLD PROMOTIONS === " + _nowStr());
  const result = _trashQuery(
    "category:promotions before:" + _getCutoffStr(),
    "ALL PROMOTIONS", "", ""
  );
  if (result.quotaExhausted) {
    Logger.log("QUOTA EXHAUSTED. Try again after reset.");
  }
  Logger.log("Trashed: " + result.trashed + "  Kept: " + result.kept + "  " + _nowStr());
}


function previewOnly() {
  Logger.log("=== PREVIEW (no deletions) === " + _nowStr());
  const senderMap = _buildSenderMap();
  let total = 0;
  Logger.log(_pad("COUNT", 6) + "  EMAIL");
  Logger.log("-".repeat(60));
  for (const [email, d] of senderMap) {
    Logger.log(_pad(String(d.count), 6) + "  " + email);
    total += d.count;
  }
  Logger.log("Total trashable: ~" + total + "  (sample: " + CFG.DISCOVERY_SCAN_SIZE + " threads)");
}


function showProgress() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("SENDER_LIST");
  const idx = parseInt(props.getProperty("SENDER_INDEX") || "0", 10);
  if (!raw) { Logger.log("No sender list. Run discoverSenders() first."); return; }
  const senders = JSON.parse(raw);
  Logger.log("=== PROGRESS ===");
  Logger.log("Completed: " + idx + " of " + senders.length);
  Logger.log("Remaining: " + Math.max(0, senders.length - idx));
  if (idx < senders.length) {
    Logger.log("Next:      " + senders[idx].name + " <" + senders[idx].email + ">  (~" + senders[idx].count + ")");
  } else {
    Logger.log("Status:    All senders processed.");
  }
}


function resetProgress() {
  PropertiesService.getScriptProperties().setProperty("SENDER_INDEX", "0");
  Logger.log("Progress reset. trashBySender() will start from sender #1.");
}


// ── INTERNALS ──────────────────────────────────────────────────

function _buildSenderMap() {
  const cutoff = _getCutoffStr();
  let threads;
  try {
    threads = GmailApp.search(
      "category:promotions before:" + cutoff, 0, CFG.DISCOVERY_SCAN_SIZE
    );
  } catch (e) {
    Logger.log("Search error: " + e.message);
    return new Map();
  }
  Logger.log("Threads fetched: " + threads.length);

  const map = new Map();
  for (const thread of threads) {
    try {
      const msg = thread.getMessages()[0];
      const from = msg.getFrom();
      const subject = msg.getSubject().toLowerCase();
      if (_isOrderSubject(subject)) continue;
      const m = from.match(/<(.+?)>/) || from.match(/(\S+@\S+)/);
      if (!m) continue;
      const email = m[1].toLowerCase().trim();
      if (_isProtectedSender(email)) continue;
      const name = from.replace(/<.*>/, "").replace(/"/g, "").trim() || email;
      if (map.has(email)) {
        map.get(email).count++;
      } else {
        map.set(email, { count: 1, name: name });
      }
    } catch (e) { /* skip */ }
  }

  return new Map(
    Array.from(map.entries())
      .filter(([, d]) => d.count >= CFG.MIN_COUNT_TO_LIST)
      .sort((a, b) => b[1].count - a[1].count)
  );
}


function _trashSender(email, cutoff, pos, senderName) {
  return _trashQuery("from:" + email + " before:" + cutoff, email, pos, senderName);
}


// Returns {trashed, kept, quotaExhausted}
function _trashQuery(query, label, pos, senderName) {
  let trashed = 0;
  let kept = 0;
  let keepGoing = true;

  while (keepGoing && trashed < CFG.BATCH_LIMIT) {
    const fetchSize = Math.min(100, CFG.BATCH_LIMIT - trashed);
    let threads;
    try {
      threads = GmailApp.search(query, 0, fetchSize);
    } catch (e) {
      if (e.message.indexOf("too many times") !== -1) {
        return { trashed: trashed, kept: kept, quotaExhausted: true };
      }
      Logger.log("Search error (" + label + "): " + e.message);
      break;
    }
    if (!threads || threads.length === 0) break;

    for (const thread of threads) {
      try {
        const msg = thread.getMessages()[0];
        const subject = msg.getSubject().toLowerCase();

        if (_isOrderSubject(subject)) {
          Logger.log(
            "  KEPT " + pos + " " + senderName +
            " (order subject): " + msg.getSubject()
          );
          kept++;
          continue;
        }

        thread.moveToTrash();
        trashed++;
      } catch (e) {
        if (e.message.indexOf("too many times") !== -1) {
          return { trashed: trashed, kept: kept, quotaExhausted: true };
        }
        Logger.log("  Error: " + e.message);
      }
      if (trashed >= CFG.BATCH_LIMIT) { keepGoing = false; break; }
    }

    if (threads.length < fetchSize) keepGoing = false;
    if (keepGoing) Utilities.sleep(150);
  }
  return { trashed: trashed, kept: kept, quotaExhausted: false };
}


function _isOrderSubject(subj) {
  for (const kw of CFG.ORDER_SUBJECT_KEYWORDS) {
    if (subj.includes(kw)) return true;
  }
  return false;
}

function _isProtectedSender(email) {
  for (const p of CFG.PROTECTED_SENDERS) {
    if (email.includes(p.toLowerCase())) return true;
  }
  return false;
}

function _isSkipped(email) {
  const el = email.toLowerCase();
  for (const s of CFG.SKIP_SENDERS) {
    if (el.includes(s.toLowerCase())) return true;
  }
  return false;
}

function _getCutoffStr() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - CFG.YEARS_OLD);
  return Utilities.formatDate(d, CFG.TIMEZONE, "yyyy/MM/dd");
}

function _nowStr() {
  return Utilities.formatDate(new Date(), CFG.TIMEZONE, "yyyy-MM-dd HH:mm:ss z");
}

function _fmtDate(d) {
  return Utilities.formatDate(d, CFG.TIMEZONE, "MMM d, yyyy");
}

function _pad(str, len) {
  return (str + " ".repeat(len)).substring(0, len);
}
