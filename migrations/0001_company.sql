CREATE TABLE company (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  fictional INTEGER NOT NULL CHECK (fictional = 1)
);
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  exchange_policy TEXT NOT NULL,
  standard_delivery_days INTEGER NOT NULL CHECK (standard_delivery_days >= 0)
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  access_code TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  status TEXT NOT NULL,
  exchange_eligible INTEGER NOT NULL CHECK (exchange_eligible IN (0,1))
);
CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE replacements (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES cases(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  created_at TEXT NOT NULL,
  fictional INTEGER NOT NULL CHECK (fictional = 1)
);
INSERT INTO company VALUES ('demo', 'Future Company', 'A fictional company selling event lighting. All orders and exchanges in this demo are simulated business records.', 1);
INSERT INTO products VALUES ('event-light', 'Event Light', 'A fictional portable light for events.', 'Damaged products are eligible for a replacement. Urgent exchanges require physical stock confirmation by staff.', 3);
INSERT INTO orders VALUES ('demo-order-1', 'DEMO-1001', 'demo-visitor', 'event-light', 'delivered', 1);
INSERT INTO orders VALUES ('demo-order-2', 'DEMO-1002', 'demo-other', 'event-light', 'delivered', 0);
