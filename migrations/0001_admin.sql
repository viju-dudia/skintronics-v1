CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    checkout TEXT NOT NULL CHECK(json_valid(checkout)),
    state TEXT NOT NULL,
    key_id TEXT NOT NULL,
    test_mode INTEGER NOT NULL CHECK(test_mode IN (0,1)),
    receipt TEXT UNIQUE,
    gateway_order_id TEXT UNIQUE,
    payment_id TEXT UNIQUE,
    total INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    customer_email TEXT NOT NULL DEFAULT '',
    customer_phone TEXT NOT NULL DEFAULT '',
    fulfilment TEXT NOT NULL DEFAULT 'awaiting' CHECK(fulfilment IN ('awaiting','processing','shipped','delivered','cancelled','returned')),
    courier TEXT NOT NULL DEFAULT '',
    tracking_number TEXT NOT NULL DEFAULT '',
    dispatch_date TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER,
    check_error TEXT,
    next_check INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_queue ON orders(test_mode, fulfilment, created_at DESC);
CREATE INDEX orders_reconcile ON orders(key_id, next_check);
CREATE TABLE locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE write_guards (id TEXT PRIMARY KEY, lease_id TEXT NOT NULL, owner TEXT NOT NULL);
CREATE TRIGGER require_current_lease BEFORE INSERT ON write_guards
WHEN NOT EXISTS (SELECT 1 FROM locks WHERE id=NEW.lease_id AND owner=NEW.owner AND expires>CAST(strftime('%s','now') AS INTEGER)*1000)
BEGIN
    SELECT RAISE(ABORT,'Order update lease expired');
END;
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL REFERENCES orders(id),
    actor TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX events_order ON events(order_id, id DESC);
CREATE TABLE refunds (
    request_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    gateway_id TEXT UNIQUE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL CHECK(status IN ('submitting','uncertain','pending','processed','failed')),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT,
    payload TEXT NOT NULL CHECK(json_valid(payload))
);
CREATE INDEX refunds_order ON refunds(order_id, created_at);
CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id),
    kind TEXT NOT NULL CHECK(kind IN ('owner_paid','customer_paid','shipped','refund')),
    detail TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    first_attempt INTEGER,
    payload TEXT,
    error TEXT
);
CREATE TRIGGER order_paid AFTER UPDATE OF state ON orders
WHEN NEW.state = 'paid' AND OLD.state <> 'paid'
BEGIN
    INSERT INTO events(order_id,actor,message,created_at) VALUES(NEW.id,'Razorpay','Payment captured and verified',CAST(strftime('%s','now') AS INTEGER)*1000);
    INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at)
      SELECT NEW.id || ':owner_paid', NEW.id, 'owner_paid', CAST(strftime('%s','now') AS INTEGER)*1000 WHERE NEW.test_mode=0;
    INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at)
      SELECT NEW.id || ':customer_paid', NEW.id, 'customer_paid', CAST(strftime('%s','now') AS INTEGER)*1000 WHERE NEW.test_mode=0;
END;
CREATE TRIGGER order_shipped AFTER UPDATE OF fulfilment ON orders
WHEN NEW.fulfilment = 'shipped' AND OLD.fulfilment <> 'shipped' AND NEW.test_mode=0
BEGIN
    INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at)
      VALUES(NEW.id || ':shipped', NEW.id, 'shipped', CAST(strftime('%s','now') AS INTEGER)*1000);
END;
CREATE TRIGGER refund_processed AFTER UPDATE OF status ON refunds
WHEN NEW.status='processed' AND OLD.status<>'processed'
BEGIN
    INSERT OR IGNORE INTO notifications(id,order_id,kind,detail,created_at)
      SELECT NEW.request_id || ':refund', NEW.order_id, 'refund', NEW.gateway_id, NEW.updated_at
      FROM orders WHERE id=NEW.order_id AND test_mode=0;
END;
